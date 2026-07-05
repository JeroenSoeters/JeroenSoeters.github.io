---
title: "Go plugins, actors, and schema evolution: Inside formae's plugin SDK"
slug: go-plugins-actors-and-schema-evolution
date: 2026-06-01
description: How formae's plugin SDK evolved across three iterations — from an in-process actor system to independent, hot-swappable plugin binaries on a schema we can change without breaking the fleet.
image: /assets/img/sdk-plugins-og.jpg
banner: /assets/img/sdk-plugins.jpg
---

Like most infrastructure-as-code (IaC) tools, **formae** has a plugin architecture. The **formae** agent knows how to schedule, queue, order, rate-limit, execute, and retry plugin operations; the actual API interaction lives in what we call **resource plugins**. This post is a short history of how our plugin SDK has evolved, the constraints that forced each change, and where we’ve landed today.

## A deliberately tiny interface

The **formae** resource plugin API is intentionally tiny. It has create/read/update/delete (CRUD) methods, a `Status` method for long-running (asynchronous) operations, a `List` method that our continuous discovery process uses, and a handful of configuration knobs. Here it is in full:

```go
type ResourcePlugin interface {
   
    // Configuration
    RateLimit() pkgmodel.RateLimitConfig
    DiscoveryFilters() []pkgmodel.MatchFilter
    LabelConfig() pkgmodel.LabelConfig
  
    // CRUD operations
    Create(ctx context.Context, request *resource.CreateRequest) (*resource.CreateResult, error)
    Read(ctx context.Context, request *resource.ReadRequest) (*resource.ReadResult, error)
    Update(ctx context.Context, request *resource.UpdateRequest) (*resource.UpdateResult, error)
    Delete(ctx context.Context, request *resource.DeleteRequest) (*resource.DeleteResult, error)
    
    // Async operation support
    Status(ctx context.Context, request *resource.StatusRequest) (*resource.StatusResult, error)
    
    // Discovery support
    List(ctx context.Context, request *resource.ListRequest) (*resource.ListResult, error)
}
```

We keep this interface as small as we can on purpose. AI coding agents already write the vast majority of plugin code, and a reliable generated plugin comes from three things working together: a small surface with little room to deviate, an extensive [conformance harness](https://github.com/platform-engineering-labs/formae/blob/main/pkg/plugin-conformance-tests/README.md) that turns “did it get it right?” into a runnable answer the agent can loop against, and [LLM-oriented documentation](https://docs.formae.io/en/latest/plugin-sdk/tutorial/) that walks through a plugin one operation at a time, test-first. The interface is just the first leg.

That interface has stayed fixed ever since. What changed, three times over, is the machinery behind it: how a plugin is loaded, where it runs, and how it talks to the agent.

## First iteration: `pkg/plugin` and Go's native plugins

The goal from day one was that a plugin developer should only have to implement the methods on `ResourcePlugin`, nothing more. We also didn't want to spawn a new process for every plugin *invocation*. The fastest way to get both was Go's built-in plugin mechanism.

Go’s `plugin` package loads compiled Go code at runtime via dynamic linking against shared objects: `.so` on Linux/FreeBSD, `.dylib` on macOS. (Notably, there's no Windows support.) A plugin looked like this:

```go
type AWS struct{}

// Compile-time check that we satisfy the contract
var _ plugin.ResourcePlugin = AWS{}

// Exported symbol the agent looks up by name
var Plugin = AWS{}

func (a AWS) Create(ctx context.Context, request *resource.CreateRequest) (*resource.CreateResult, error) {
    // AWS provisioning code
}
```

Building it:

```
go build -C plugins/aws -buildmode=plugin -o aws.so
```

The plugin source is ordinary Go in `package main` (even though no `main()` ever runs). The toolchain produces an ELF (Mach-O on macOS) shared library with Go's runtime metadata baked in: type information, GC pointers, and so on. That metadata is exactly why these aren't just plain C-style shared libraries.

On the agent side, loading looked like this:

```
dl, err := goplugin.Open("aws.so")
if err != nil {
    return err
}

// Look up the exported "Plugin" symbol
sym, err := dl.Lookup("Plugin")
if err != nil {
    return err
}
plug, ok := sym.(plugin.ResourcePlugin)
if !ok {
    return fmt.Errorf("aws.so does not implement ResourcePlugin")
}

// Now we can use the plugin
plug.Create(ctx, req)
```

The plugin ran in-process inside the agent, and the developer only had to implement `ResourcePlugin`. For a while, this was great.

## Where it broke down

This is where most people who try Go’s `plugin` package get hurt. The mechanism only works if the agent and the plugin are built in near-perfect lockstep, and that requirement shows up in two ways.

The first is the **toolchain**. The plugin and the agent must be built with the exact same Go version; even a patch-level mismatch is refused at load time. While every plugin lived in the **formae** monorepo this was a non-issue, since a single Makefile pinned one toolchain for every build. But it would clearly become a problem once anyone started building plugins on their own machines and their own schedules.

The second, and the one we couldn’t engineer around, is **dependencies**. Any package imported by *both* the host and the plugin must be at the exact same version, built with the exact same flags (down to things like `-race` and `-tags`). This one isn't fixable on our side: we can't control, or safely pin, the transitive dependencies that the many SDKs we wrap drag in. The moment two of them conflict, the plugin won't load, full stop.

We hit all of this while plugins were still in the monorepo, before we’d shipped a public SDK at all. It was enough to make the verdict obvious: a public plugin SDK built on Go’s `plugin` package was a dead end, and we needed a fundamentally different approach.

## Second iteration: lift the plugin into its own process with Ergo

The **formae** agent is built on the [Ergo](https://ergo.services/) actor framework, which brings an Erlang-style concurrency model to Go. (If the actor model is new to you, I wrote a separate [primer on the actor model and Ergo](/unlocking-concurrency-in-go-67a530807616).) For this post, you only need one idea: the actor model’s unit of concurrency is a **process**. Not an OS process, but a lightweight process managed by a VM. In Erlang that VM is the BEAM; in Ergo it’s the **Ergo node**. Processes talk to each other by sending messages, and a process can spawn new processes.

The **formae** agent hosts an Ergo node, and everything the agent does is carried out by one or more Ergo processes, including plugin operations like the `Create` call above. The actor that orchestrates plugin operations is the **PluginOperator**.

So we asked: what if we lift the PluginOperator out into a *separate* OS process running its own Ergo node (a “plugin process”), and let it talk to the agent over the message protocol the agent already speaks everywhere internally: Ergo messages?

This isn’t a process per invocation. It’s a persistent process that the agent communicates with by message-passing. And because each plugin is now its own binary, the dependency-hell problem simply disappears: there’s no shared linking anymore. The same separation decouples licensing: since a plugin isn’t linked into the agent, it can carry whatever license its author chooses, so OSS and proprietary plugins can be onboarded side by side. The developer still implements only `ResourcePlugin`; the SDK is now a normal Go binary with a `main()` that we already provide, which bootstraps the Ergo node and hoists the plugin implementation into an actor process.

The piece that makes this elegant is a foundational Erlang/OTP idea: **network transparency**. The location of a process (same Ergo node, a different node on the same machine, or a node halfway around the world) doesn’t change how you interact with it.

Concretely this means you send messages the same way regardless of where the receiving process lives. A `Send` to a local process and a `Send` to a process on another continent are written identically; only the target process identifier (PID) differs. We rely on this in three places:

- **Workflow tests** (our automated tests that validate actor orchestration) must *not* spin up a subprocess per test, so there we spawn the PluginOperator locally on the agent’s node and messages stay in-process.
- In the **OSS formae agent**, all plugins run locally on the agent host, so in production the messages cross the process boundary but stay on one machine.
- For running **formae** at scale, the **paid version** supports *satellite agents*: agents on different hosts that manage plugin processes and relay back to the primary agent.

Network transparency makes the agent oblivious to topology. From its perspective it’s just exchanging messages with a PluginOperator process, wherever that process happens to run.

Here is the shape of the change. Before, the whole pipeline lived in the agent process and shared one address space:

{{screenshot: sdk-01.jpg | All actors share one address space; messages never leave the process.}}

After, each plugin runs in its own separate process, with its own Ergo node and binary. The ResourceUpdater drives them all the same way, and the messages now cross a process boundary instead of staying in-process:

{{screenshot: sdk-02.jpg | Each plugin runs in its own process. The same message send reaches every one, wherever it lives.}}

## The first schema change

This worked beautifully in the first public SDK release. Then we needed to change the schema, meaning the message contract between the agent and the plugins. Many early SDK adopters will have painful memories of this:

```
ERR ... unable to decode received message: malformed EDF: end of data
```

The binary serialization format Ergo uses on the wire is the **Ergo Data Format (EDF)**. Out of the box, EDF serializes a registered Go type field by field, and both ends of a connection have to share the exact same definition of that type.

The type that bit us was the schema. On startup, every plugin announces its resource schemas to the agent: the fields each resource has, plus a set of annotations the engine needs, things like whether a field is create-only, whether it’s required, or how it links a resource to its parent. These schemas are authored in Pkl and translated to Go, and they change constantly, because we add new annotations as new engine features land. A trimmed-down version of one annotation type:

```go
type FieldHint struct {
    CreateOnly       bool
    WriteOnly        bool
    Required         bool
    RequiredOnCreate bool
}
```

When a new feature needs a new annotation, we add a field:

```go
type FieldHint struct {
    CreateOnly       bool
    WriteOnly        bool
    Required         bool
    RequiredOnCreate bool
    EdgeKind         EdgeKind // new: how this field links resources in the dependency graph
}
```

Under native EDF, that one addition was enough to break things. These annotation types are nested inside the announcement message, so changing `FieldHint` changed the registered type of the whole announcement. An agent built against the new definition and a plugin still compiled against the old one no longer agreed, and EDF refused to decode the message. That is the `malformed EDF` error above, and because it happened at announce time, an out-of-date plugin couldn't even start.

For a plugin SDK, that’s a non-starter: a backwards-compatible change on our side should never force every plugin author to recompile and re-publish on our release schedule.

## Third iteration: MessagePack to the rescue

Fortunately, iteration three was a far smaller pivot than the jump to separate processes. Ergo lets you supply custom marshalers: `MarshalEDF(w io.Writer) error` and `UnmarshalEDF(data []byte) error`. EDF doesn't disappear as the wire protocol; instead, your custom payload gets wrapped in EDF's framing. On the wire it looks roughly like this:

```go
[ EDF type tag ][ EDF length prefix ][ your MarshalEDF output ]
```

The EDF decoder reads the type tag, and if the type implements `Unmarshaler`, it allocates a value of that registered type and calls `UnmarshalEDF(bytes)` on it.

The important shift is that EDF no longer looks *inside* the message. It matches on the registered type tag and treats the body as an opaque blob, so the struct’s fields are no longer part of what the two nodes have to agree on. The body’s encoding is now ours to choose.

We chose **MessagePack**. Protobuf was the obvious alternative, but it brings a codegen step and a schema toolchain we didn’t want, and its main payoff, a language-neutral contract, is wasted on us: these messages change quickly and will only ever be read by Go.

For most messages the marshaler is a one-liner on each side. The plugin announcement that carries the schemas is just another message type:

```go
func (m PluginAnnouncement) MarshalEDF(w io.Writer) error    { return encodeMsgpack(w, &m) }
func (m *PluginAnnouncement) UnmarshalEDF(data []byte) error { return decodeMsgpack(data, m) }
```

Because MessagePack encodes each field by name (the body is a map keyed by field name, not a fixed sequence of positions), adding an annotation no longer breaks the announcement. A node that doesn’t know a new annotation skips it; a node that receives an older schema simply doesn’t see the annotations that weren’t there yet. A plugin compiled against last month’s schema announces successfully to today’s agent, and nobody has to recompile.

Missing annotations come back as zero values, which isn’t always the behavior we want for an older schema. So as we read schemas (they originate as Pkl, and cross into Go as JSON keyed by the same field names), we normalize the older shapes. The deprecated `AttachesTo` flag, for example, is folded into the newer `EdgeKind`:

```go
func (fh *FieldHint) UnmarshalJSON(data []byte) error {
    type alias FieldHint
    var raw alias
    if err := json.Unmarshal(data, &raw); err != nil {
        return err
    }
    *fh = FieldHint(raw)
    if fh.EdgeKind == "" { // schema predates EdgeKind
        fh.EdgeKind = EdgeKindDefault
        if fh.AttachesTo { // derive it from the deprecated annotation
            fh.EdgeKind = EdgeKindAttachesTo
        }
    }
    return nil
}
```

A new annotation, which used to break every plugin’s startup, is now an additive change. Schema evolution becomes a local change on our side instead of a coordinated, fleet-wide recompile.

Getting there did surface one bug in Ergo’s own length-prefix handling, which produced the same `malformed EDF` error for large custom-marshaled payloads; we [fixed it upstream](https://github.com/ergo-services/ergo/pull/257).

## Where we are today

Three iterations in, the contract for a plugin author is still the same one we started with (implement `ResourcePlugin`), but everything underneath has been rebuilt for a world where plugins are independent binaries, evolving on a schema we can change without breaking anyone. Today they can be written by anyone (and increasingly by AI agents), deployed across hosts, and published and shared on [formae/hub](https://hub.platform.engineering), our plugin registry.
