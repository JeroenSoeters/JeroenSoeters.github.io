---
title: "Unlocking concurrency in Go: A practical guide to the actor model with Ergo"
slug: unlocking-concurrency-in-go
date: 2025-05-15
description: A practical guide to the actor model in Go with the Ergo framework — where actors came from, why they beat shared-state threading, and a worked prime-factoring example.
image: /assets/img/concurrency-go-og.jpg
banner: /assets/img/concurrency-go.jpg
---

Hollywood stars in software engineering, you think? No, it’s not the actors you see in TV shows we’ll cover in this article. These are the actors the late Carl Hewitt coined in the early 70s when he was researching how to program highly parallel computers.

## The Actor Model: A Different Paradigm for Concurrent Computation

The actor model is a paradigm for concurrent computing. It’s an alternative to traditional threading/locking, which is the prevailing way of writing concurrent code in C++ or Java, or Communicating Sequential Processes (CSP), which forms the basis of Go’s native concurrency primitives: goroutines and channels.

In the actor model, everything is an actor. As E.O. Wilson famously said, “One ant is no ant.” The same holds for actors: “One actor is no actor.” Actors come in systems, and because they come in systems, they need addresses, so they can send messages to each other. Of course, an actor can also send a message to itself, which is how recursion is implemented in the actor model.

As the fundamental unit of computation, an actor encompasses three things:

- Processing: the actor needs to be able to get something done
- Storage: actors need to be able to remember things
- Communication: actors need to be able to communicate with one another

The behavior and capabilities of actors are defined by a fundamental set of axioms, primarily articulated by Hewitt, Bishop, and Steiger. When an actor receives a message, it can perform three fundamental actions:

1. It can create more actors, allowing the system to dynamically expand, delegate tasks, and form hierarchical structures. For example, a `ShoppingCartActor` might create subordinate `PaymentActor` and `ShippingActor` instances to handle specific parts of an order process. This capability is essential for building systems that adapt their resource allocation and structure in response to varying workloads or events. This axiom is what enables advanced fault-handling strategies by creating so-called supervision hierarchies on which we’ll talk more in a future blog post.
2. It can send messages to other actors of which it has addresses: this is the exclusive mechanism for inter-actor communication and coordination. This axiom underscores the message-centric nature of the actor model.
3. It can designate the behavior to be used for the next message it receives. In essence this means it can change its internal state and consequently how it responds to future messages based on the sequence of messages it has already processed. A `DepositAccountActor` with a balance of $5, after receiving a deposit message of $7, will handle the next message with a balance of $12.

## Actors: OOP as it was meant to be?

Ironically, this is not very dissimilar to what Alan Kay, the inventor of Object-Oriented programming (OOP), had in mind when he coined the term. His core principles for OOP included:

- Messaging: objects must interact by sending and receiving messages
- Encapsulation of state: each object is solely responsible for its own data, which must be shielded from any external interference
- Extreme Late-Binding: the decision which piece of code to execute in response to a received message should be deferred until the message is actually received at runtime (parametric polymorphism).

He regretted the term “objects” and argued that true object-oriented programming focuses on inter-communicating entities (objects) that interact through messages, rather than the objects themselves. He famously said: “I invented the term Object-Oriented, and I cant tell you I did not have C++ in mind”.

## Erlang: The Battle-Tested Actor Powerhouse

No discussion of the actor model is complete without acknowledging Erlang, a programming language and runtime system where actor-like principles are not just a library feature, but the very foundation of its concurrency model.

Erlang was developed at Ericsson in the 1980s to build highly available, massively concurrent, and fault-tolerant telecommunications systems, such as telephone switches. The primary design goals were concurrency, distribution, soft real-time performance, and continuous operation. These requirements naturally led to an architecture closely resembling the actor model.

Erlang’s decades of success in building some of the world’s most reliable and scalable concurrent systems (e.g., WhatsApp, Ericsson’s AXD301 switch) has profoundly influenced many subsequent actor model implementations in other languages and platforms, including Akka for the JVM, Orleans for.NET, and, by extension, Go’s Ergo framework.

## Ergo: Actors for the Next Generation of Infrastructure Tooling

At Platform Engineering Labs, we are building the next generation of infrastructure tooling. Although we have our fair share of Erlang aficionados among our colleagues, we have adopted Go as our primary programming language. Go has become the leading language for modern infrastructure tooling and cloud-native development. A vast majority of CNCF projects, which form the bedrock of the cloud-native ecosystem, are all written in Go. This quickly led us to the [Ergo Framework](https://github.com/ergo-services/ergo). Ergo aims to bring the power and elegance of Erlang/OTP’s actor-based design patterns to the Go programming language. It provides a robust platform for building scalable, fault-tolerant, and distributed applications.

Ergo is heavily inspired by Erlang. It is built upon lightweight processes, which are themselves implemented using Go’s native goroutines. A notable characteristic is its “zero external dependencies” philosophy, relying solely on the Go standard library. Ergo offers a rich set of features to facilitate actor-based development. We’ll walk through the basic ones with a simple task dispatcher example. In this example, we will create a `TaskDispatcherActor`, which dynamically spins up a pool of `Worker` actors to calculate prime numbers within a given range. We divide the range across the pool of workers, and each worker will report the primes they found to a `ResultsCollector` actor.

Sounds simple enough? Let’s create our first actor. In Ergo, we create an actor by embedding the`Actor` type in a struct.

```go
type TaskDispatcher struct {
  act.Actor
  numberOfWorkers int
}
```

You interact with the actor via the `ActorBehavior` interface, which `Actor` implements. All methods in this interface are optional. The first one we implement for our `TaskDispatcher` actor is the `Init(args …any) error` method. This method runs at the start of process initialization, and allows us to pass in arguments and set up some initial state. It is important to note that during this initialization, functionality like creating actors or sending messages to other actors is not yet available to us. We can only do this later in the lifecycle upon receiving messages. Remember those axioms? All we do in this initialization is parse the number of workers we want the dispatcher to create from the arguments and store this in the actor state.

```go
func (td *TaskDispatcher) Init(args …any) error {
  if (len(args) > 0) {
    td.numberOfWorkers = args[0].(int)
  } else {
    // default number of workers to 4
    td.numberOfWorkers = 4
  }
  return nil
}
```

Now let’s define some messages for our actors to pass around. We define a message `CalculatePrimes` with a range and another message `PrimesFound` to pass along the results to our `ResultsCollector` actor.

```go
type CalculatePrimes struct {
  RangeStart int
  RangeEnd int
}

type PrimesFound struct {
  Primes []int
}
```

The next method we have to implement is the `HandleMessage(from gen.PID, message any) error` method. Our `TaskDispatcher` actor only receives a single type of message, the `CalculatePrimes` message. When it receives this message, the `TaskDispatcher` first spawns the requested number of worker actors. It uses the `Spawn(factory ProcessFactory, options ProcessOptions, args …any) (gen.PID, error)` method of the `Process` interface, which `Actor` embeds. The Spawn method returns a `PID`. `PID` stands for process identifier, and it represents the address of the actor that we need to be able to send messages to it. We divide the requested range among the workers and send each worker a `CalculatePrimes` message for the assigned range.

```go
func (td *TaskDispatcher) HandleMessage(from gen.PID, message any) error {
  switch msg := message.(type) {
  case CalculatePrimes:
    for i := range td.numberOfWorkers {
      rangeSize := (msg.RangeEnd - msg.RangeStart + 1) / td.numberOfWorkers
      workerRangeStart := msg.RangeStart + i*rangeSize
      workerRangeEnd := workerRangeStart + rangeSize - 1

      pid, err := td.Spawn(
        func() gen.ProcessBehavior {
          return &Worker{}
        }, gen.ProcessOptions{})
      if err != nil {
        log.Fatalf("failed to spawn worker actor: %v", err)
      }

      td.Send(pid, CalculatePrimes{workerRangeStart, workerRangeEnd})
      if err != nil {
        log.Fatalf("failed to send messag to worker actor: %v", err)
      }
    }
  default:
    td.Log().Error("Unknown message: %v", msg)
  }
  return nil
}
```

Now we have to implement `HandleMessage(…)` for the Worker actor. The worker actor finds the primes in the range and forwards the results to the `ResultsCollector` actor. Note that the Worker actors do not know the `PID` of the `ResultsCollector`. In addition to Spawn, Ergo provides another method to create new actors: `SpawnRegister(register gen.Atom, factory ProcessFactory, options ProcessOptions, args …any) (gen.PID, error)`. This allows us to associate a name with an actor; other actors can send messages using this name as the address.

Actors can terminate themselves by returning a non-nil error from the handler. Here, we return the `gen.TerminateReasonNormal` error type for a normal shutdown scenario after the worker is done processing.

```go
func (w *Worker) HandleMessage(from gen.PID, message any) error {
  switch msg := message.(type) {
  case CalculatePrimes:
    primes := findPrimesInRange(msg.RangeStart, msg.RangeEnd)
    err := w.Send(gen.Atom("ResultsCollector"), PrimesFound{primes})
    if err != nil {
      log.Fatalf("failed to send messag to worker actor: %v", err)
    }
    return gen.TerminateReasonNormal
  default:
    w.Log().Error("Unknown message: %v", msg)
  }
  return nil
}
```

Next, we implement `HandleMessage(…)` of the `ResultsCollector` actor, which waits for all results to come in and prints them to the screen.

```go
func (rc *ResultsCollector) HandleMessage(from gen.PID, message any) error {
  switch msg := message.(type) {
  case PrimesFound:
    rc.results = append(rc.results, msg.Primes…)
    rc.numberOfResults = rc.numberOfResults + 1
    if rc.numberOfResults == rc.expectedNumberOfResults {
      fmt.Printf("All results collected. Found the following primes: %v", msg.Primes)
    }
  default:
    rc.Log().Error("Unknown message: %v", msg)
  }
  return nil
}
```

To create our initial actor, we have to create an Ergo node. The node is the core service in Ergo that hosts the actor runtime. Each node has a name that consists of two parts: the name of the node and the network interface the node binds to.

We create a node using the `Start(name gen.Atom, options gen.NodeOptions, frameworkVersion gen.Version) (gen.Node, error)` method. In the main goroutine, we create our `TaskDispatcher` actor as well as the `ResultCollector` actor and send the `CalculatePrimes` message to the `TaskDispatcher` to start our example.

```go
func main() {
  name := gen.Atom("example@localhost")
  node, err := ergo.StartNode(name, gen.NodeOptions{})
  if err != nil {
    log.Fatalf("Failed to start the Ergo node: %v", err)
  }
  tdPid, err := node.Spawn(factoryTaskDispatcher, gen.ProcessOptions{}, 5)
  if err != nil {
    log.Fatalf("Failed to spawn the task dispatcher: %v", err)
  }
  _, err = node.SpawnRegister(gen.Atom("ResultsCollector"), func() gen.ProcessBehavior { return &ResultsCollector{} }, gen.ProcessOptions{}, 5)
  if err != nil {
    log.Fatalf("Failed to spawn the task dispatcher: %v", err)
  }
  node.Send(tdPid, CalculatePrimes{0, 100})
  node.Wait()
}
```

The full example code is available on [GitHub](https://github.com/JeroenSoeters/erg-task-dispatcher/tree/master).

In a future blog post, we will dive deep into Ergo’s advanced fault-handling strategies using supervision hierarchies.
