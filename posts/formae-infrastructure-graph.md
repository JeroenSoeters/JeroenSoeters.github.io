---
title: "Targets, resources, resolvables and stacks: The formae infrastructure graph explained"
slug: formae-infrastructure-graph
date: 2026-06-10
description: How formae's core concepts — targets, resources, resolvables, and stacks — compose into one infrastructure graph, and why the power is in how they combine rather than in any one of them.
image: /assets/img/graph-og.jpg
banner: /assets/img/graph-banner.jpg
---

--

Listen

Share

formae is built from a small set of composable concepts, and their power is in how they combine. The goal of this article is to make it easier to see the overall structure of a formae codebase.

In infrastructure codebases, the problems that matter most tend to surface at the joins: the points where resources managed by one plugin depend on resources managed by another. These cross-plugin dependencies are the ones mainstream IaC tools handle worst, pushing you toward separate states, separate apply runs, or a dedicated mechanism just to carry a value across the boundary. formae models all of it as a single graph.

That graph is built from just four concepts: resources, targets, resolvables, and stacks. We will look at each on its own first.

## Resources

A resource is a single piece of infrastructure: an S3 bucket, a VPC, an ECS service, a Grafana dashboard. Each resource has a type, like `AWS::S3::Bucket` or `GRAFANA::Core::Dashboard`, and a set of properties that describe the state you want: a bucket has a name, a VPC has a CIDR block, a dashboard has a title and a folder.

## Targets

A resource never exists in the abstract; it lives somewhere, and that somewhere is a *target*. A target is the connection formae uses to reach a place and act on it: to create and manage resources there, and read their state back. Every resource belongs to exactly one target. A target you mark `discoverable` is also one formae scans for resources that already exist.

A target has a label and a `config` that holds whatever formae needs to talk to that place.

What goes in the config depends on the plugin. An AWS target needs a region, and a Grafana target needs the URL of the Grafana instance. A Kubernetes target needs more: an auth strategy that knows how to reach and authenticate to the cluster, anything from a local kubeconfig to cloud-native auth for EKS, GKE, or AKS.

## Resolvables

Most resources need to know something about another resource before they can be created. A subnet needs the ID of the VPC it sits in; an ECS service needs the ARN of its task definition. The catch is that those values do not exist when you write your Pkl. The VPC has no ID until AWS creates it, so there is nothing to paste in.

A *resolvable* lets you refer to the value anyway. Instead of a literal, you point at the resource and the property you want, written as `vpc.res.vpcId`: the id of the `vpc` resource, whatever it turns out to be. The `.res` accessor reaches into a resource's applied state, the version that exists once formae has created it.

Two things follow. First, formae resolves the value late, at apply time, not when you write the code: it creates the VPC, reads back the ID that was assigned, and only then creates the subnet with that ID in hand. Second, the reference tells formae the order to work in. Because the subnet points at the VPC, formae knows the VPC comes first, and that resources which do not point at each other can be created in parallel. You write down what needs what, and the order to build things in falls out of that.

The underlying algorithm that works out this ordering is more complicated than this, but we will cover this in a future article.

## Stacks

A stack is a named group of related resources. Every resource belongs to exactly one stack, just as it belongs to exactly one target.

The grouping matters when you apply. Running `formae apply --mode reconcile` makes each stack in your Pkl match its definition exactly: a resource in your Pkl that does not exist yet is created, a resource that exists but is no longer in your Pkl is deleted, and any other difference becomes an update or a replace, depending on the property.

This is what makes a stack the scope of a reconcile. formae will create, change, and delete to make the running infrastructure match your Pkl, but only within the stacks you give it, so the way you group resources into stacks decides what a single reconcile can change or delete.

If you want to automatically clean up a set of resources, you set a time-to-live policy on a stack. If you want to automatically undo out-of-band changes, you set an auto-reconcile policy on a stack. Policies like these are set per stack, so they are another thing to weigh when designing stacks.

## Putting it together

At first, this was the whole picture: pick a cloud, declare some resources, wire them together with resolvables, and group them into a stack. Here is a small AWS example: a network, and an EKS cluster to run workloads on.

```pkl
amends "@formae/forma.pkl"

import "@formae/formae.pkl"
import "@aws/aws.pkl"
import "@aws/ec2/vpc.pkl"
import "@aws/ec2/subnet.pkl"
import "@aws/eks/ekscluster.pkl"
local mainVpc = new vpc.VPC {
    label = "main-vpc"
    cidrBlock = "10.0.0.0/16"
    enableDnsHostnames = true
}
local publicSubnet = new subnet.Subnet {
    label = "public-subnet"
    vpcId = mainVpc.res.vpcId
    cidrBlock = "10.0.1.0/24"
    availabilityZone = "us-east-1a"
}
local appCluster = new ekscluster.Cluster {
    label = "app-cluster"
    name = "app-cluster"
    version = "1.31"
    resourcesVpcConfig = new ekscluster.ResourcesVpcConfig {
        subnetIds { publicSubnet.res.subnetId }
    }
    // a real cluster also needs an IAM role, security groups, and subnets
    // across two AZs; trimmed here to keep the example readable
}
forma {
    new formae.Stack { label = "platform" }
    new formae.Target {
        label = "aws"
        config = new aws.Config { region = "us-east-1" }
    }
    mainVpc
    publicSubnet
    appCluster
}
```

That Pkl already describes a graph. Drawn out, it is a short chain:

{{screenshot: graph-01.jpg | AWS / EKS stack: one target, resources resolving into each other}}

The target says where everything goes, an AWS account in us-east-1. If you only declare a single target, every resource automatically lands in it. The VPC, subnet, and cluster are the resources. The resolvables are the wiring: the subnet takes `mainVpc.res.vpcId` and the cluster takes `publicSubnet.res.subnetId`, so formae builds the VPC first, then the subnet, then the cluster. All three belong to one stack, `platform`, the unit you would reconcile or tear down as a whole.

When we first shipped formae, the only plugins were for cloud providers, so this is what most setups looked like: a target at the root with resources hanging off it. You could provision the EKS cluster, but anything you ran on it was beyond formae’s reach. As we added plugins for more than cloud providers, formae could manage what runs on the cluster too.

## Targets inside the graph

In every example so far the target sat at the root. But look again at what a target is. It has a `config`, and a config is just data. We have already seen that data does not have to be a literal you write by hand; it can be a resolvable. So nothing stops a target's config from reading its values out of another resource.

This is where composition starts to shine: a target’s connection is built from a resource that lives in another target. Here is the Kubernetes target for the cluster from the previous section:

```
import "@k8s/k8s.pkl" as k8s

local appK8s = new formae.Target {
    label = "app-k8s"
    config = new k8s.Config {
        kubernetesVersion = "1.31"
        auth = new k8s.EKSAuth {
            endpoint = appCluster.res.endpoint
            certificateAuthority = appCluster.res.certificateAuthorityData
            clusterName = appCluster.res.name
        }
    }
}
```

`appCluster` is the EKS cluster from the AWS target. Its endpoint, CA, and name do not exist until formae has created it, so the Kubernetes target reads them through `.res`, exactly the way the subnet read the VPC id.

Because that config reads from the cluster, the ordering rule from the resolvables section now applies to the target as well: formae brings the Kubernetes target up only after the cluster it points at exists.

With the target defined, Kubernetes resources live inside it the same way the VPC and subnet live inside the AWS target. Here we deploy Grafana onto the cluster: a namespace, and a LoadBalancer Service in front of it.

```
import "@k8s/v1.31/core/Namespace.pkl" as ns
import "@k8s/v1.31/core/Service.pkl" as svc

local appNs = new ns.Namespace {
    label = "observability"
    target = appK8s.res
    metadata = new ns.NamespaceMetadata { name = "observability" }
}
local grafanaSvc = new svc.Service {
    label = "grafana"
    target = appK8s.res
    metadata = new k8s.NamespacedObjectMeta {
        name = "grafana"
        namespace = appNs.res.name
    }
    // a LoadBalancer Service fronting the Grafana pods; spec omitted for brevity
}
```

With more than one target in play, each resource has to say which one it belongs to: both set `target = appK8s.res`, so they land in the Kubernetes target rather than the AWS one. And the Service reads its namespace from `appNs` through the same `.res` mechanism.

That is the graph two targets deep: an AWS target with a cluster inside it, and a Kubernetes target hanging off the cluster with resources of its own.

{{screenshot: graph-02.jpg | Two targets: the Kubernetes target reads the EKS cluster}}

The recursion does not stop here. To create Grafana’s own resources, its folders and dashboards, we need a Grafana target. That target needs a URL: where the running Grafana can be reached. The LoadBalancer Service we just deployed has one, so the Grafana target reads it the same way the Kubernetes target read the cluster:

```
import "@grafana/grafana.pkl"

local grafanaTarget = new formae.Target {
    label = "grafana"
    namespace = "GRAFANA"
    config = new grafana.Config {
        url = grafanaSvc.res.lbIngressUrl
    }
}
```

Grafana’s own resources, a folder and a couple of dashboards, live in that target:

```
import "@grafana/core/folder.pkl"
import "@grafana/core/dashboard.pkl"

local dashboards = new folder.Folder {
    target = grafanaTarget.res
    label = "app-dashboards"
    uid = "app-dashboards"
    title = "App Dashboards"
}
local latency = new dashboard.Dashboard {
    target = grafanaTarget.res
    label = "latency"
    uid = "latency"
    title = "Latency"
    folderUid = dashboards.res.uid
    configJson = read("dashboards/latency.json").text
}
local errors = new dashboard.Dashboard {
    target = grafanaTarget.res
    label = "errors"
    uid = "errors"
    title = "Errors"
    folderUid = dashboards.res.uid
    configJson = read("dashboards/errors.json").text
}
```

So the pattern repeats, and then it repeats again. An AWS target holds a cluster; a Kubernetes target connects to that cluster and runs Grafana; a Grafana target connects to Grafana and holds the dashboards. `[target] → resources → [target] → resources → [target] → resources`, as far down as your infrastructure goes. None of the primitives changed: the same `Target`, the same resources, the same `.res`. Three plugins compose in one place, and every connection between them is a resolvable instead of a value copied across a boundary.

{{screenshot: graph-03.jpg | Three targets composing in one graph; stacks cut across the nesting}}

Notice too that stacks are orthogonal to the nesting: the diagram keeps the AWS and Kubernetes resources in a single `platform` stack, but we could have split them however we wanted. A resolvable can cross a stack boundary just as it crosses a target boundary, so resources in different stacks can still reference each other. A stack groups resources for reconcile; it does not have to follow the target boundaries.

## Changing the graph

Every time you run `formae apply`, formae compares your Pkl to the actual infrastructure and works out the necessary operations: what to create, update, replace, or destroy. The edges of the graph decide the order of these operations. For example, in Kubernetes you cannot update a Service's `loadBalancerClass`; you have to delete the Service and recreate it. formae understands this: it deletes the existing Grafana resources and the target first, then recreates them once the new Service is up. Changing a property that doesn't require the Service to be deleted and recreated, for example adding a label, will not result in any downstream operations.

## The same target, any substrate

A nested target is only as useful as the connection it reads from. This is why we put real thought into those connections. Take Grafana: a Grafana target needs a URL for the Grafana HTTP API, so whatever runs Grafana has to expose something that resolves to one. What that is depends on where Grafana runs. On Kubernetes, the Grafana Service is a LoadBalancer and exposes an `lbIngressUrl`. On ECS behind a load balancer, the ECS Service publishes a set of endpoints keyed by container and port. On Docker Compose, the stack publishes endpoints the same way. Each is a different resource with a different output, and part of a plugin's job is to make what it exposes resolvable into the URL the Grafana target expects.

The payoff is reuse. The same Grafana target, with the same folders and dashboards inside it, can sit on any of them: wire its `url` to whatever the substrate exposes and nothing else changes. We saw the Kubernetes form in the previous section, reading `grafanaSvc.res.lbIngressUrl`. On a Docker Compose stack, the URL comes from the stack's endpoints instead:

{{screenshot: graph-04.jpg | The same Grafana target on a Docker Compose stack}}

And on ECS, from the service’s endpoints, with a load balancer and target groups doing the routing behind it:

{{screenshot: graph-05.jpg | The same Grafana target on ECS behind a load balancer}}

In all three the Grafana target and its dashboards are identical. Where Grafana runs becomes a wiring decision rather than a rewrite.

## How other tools handle this

That chain from the cluster to Kubernetes to Grafana crosses two plugin boundaries, and in formae it stays inside one graph because a target’s connection is data, and that data can be a resolvable that resolves at apply time. Most tools draw a line right there. Terraform does not treat providers as nodes in its plan graph, so a Kubernetes provider cannot read a cluster built in the same run, and the usual fix is to split into two states and two applies. Pulumi does better within one program, where an explicit provider can take a cluster’s output as input, but carrying that across stacks or projects means routing it through a StackReference. Crossplane stays declarative, but connecting to a cluster it provisions goes through a Kubernetes Secret rather than a direct reference. In each case the handoff from one plugin to the next is where the extra work lives: a second state, a cross-stack reference, a connection secret.

In formae that boundary is an ordinary edge. The Grafana target reading `service.res.endpoints.at("grafana:3000")` is the same kind of reference as a subnet reading `mainVpc.res.vpcId`: no provider object to instantiate, no second apply, no secret passed by hand. Late binding is what enables this: the resolvable resolves once the resource it points at is ready, so a cross-plugin dependency lives in the data model like any other reference.

## Wrapping up

Hopefully this article has given you a clearer picture of the formae infrastructure graph: enough to read an existing codebase, or design one yourself. Notice that none of the later sections introduced any new concepts. The same resources, targets, resolvables, and stacks that describe a single VPC also describe a cloud account running Kubernetes running Grafana. The concepts are few on purpose. What they compose into is anything but.
