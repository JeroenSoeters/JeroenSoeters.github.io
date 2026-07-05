---
title: Solving Infrastructure Drift With formae
slug: solving-infrastructure-drift-with-formae
date: 2025-12-11
description: When your infrastructure code is up to date, there is no drift. How formae detects out-of-band changes and lets you reconcile — or absorb — them, instead of fighting drift.
image: /assets/img/solving-drift-og.jpg
banner: /assets/img/solving-drift.jpg
---

## When your infrastructure code is up-to-date, there is no drift.

1

Drift is a common challenge in the infrastructure-as-code (IaC) world. Infrastructure drift is the phenomenon where the actual state of infrastructure diverges from the desired state defined in code. This happens, for example, when changes are made directly to the infrastructure outside of the IaC tools. A core characteristic of the existing IaC platforms is the assumption of centrality and full ownership — that the IaC tool itself is the sole source of truth and the *only* approved mechanism for infrastructure modifications. This design philosophy inevitably leads to the questionable best practice of prohibiting or severely restricting changes outside of the IaC workflow.

Meet *formae*, the IaC tool built to embrace the operational challenges from using various tools and approaches. *formae* continuously monitors your live infrastructure and codifies it into a single, versioned source of truth. When out-of-band changes are detected, *formae* automatically ** turns them into infrastructure code, and allows you to incorporate these changes into your own IaC codebase.

In this article, we will look at how this works in practice.

## Synchronization

The *formae* agent is an active component that typically runs in the target infrastructure. When you submit a *formae* command via the CLI, the agent executes this command, not the CLI process. This allows *formae* to be intelligent about command execution. When conflicting commands are submitted by multiple people, *formae* can decide whether to queue the commands, reject the commands or execute them in parallel.

But this is not all the agent is doing. The agent also periodically synchronizes its internal state with your live infrastructure to detect any out-of-band changes. You can customize at what interval this synchronization happens in the *formae* configuration. During the synchronization *formae* will compare all resources it knows about with their counterparts in the live infrastructure. If any differences are found, *formae* will store new versions of those resources internally. It also keeps record of which changes were made by the user via *formae* commands, and which were made outside of the tool.

You can view the current state of your infrastructure by using the `formae inventory` command. Let’s take a look at how this works.

## Creating a Resource with formae

First, let’s create an AWS S3 bucket using *formae*. The forma Pkl file looks like this:

{{screenshot: drift-01.jpg | buc-ee.pkl}}

Based on this forma Pkl, *formae* will create a stack called `buc-ees` with a single AWS S3 bucket resource. We can apply this forma using the `formae apply `command.

{{screenshot: drift-02.jpg}}

We should see the resource being created. The `--watch` flag allows us to follow the progress of the operation. *formae* commands execute asynchronously on the agent, so we can at any time safely exit the CLI and at a later point check in on the status using `formae status` command.

When the operation completes, we can verify in the AWS Management Console that the bucket is created.

{{screenshot: drift-03.jpg}}

Success! The S3 bucket has been created as expected. Now let’s use the `formae inventory` command to see if *formae* is tracking the resource.

{{screenshot: drift-04.jpg}}

By default *formae* displays a human-friendly view of the resource. We can see the machine-friendly output using the`--output-consumer machine` flag. We will do this in a bit.

Now let’s return to the AWS Console and make an out-of-band change to the AWS S3 bucket. For this example, we will add a tag to the bucket.

{{screenshot: drift-05.jpg}}

We wait for *formae*’s synchronization job to pick up the change, and again run the `formae inventory` command. Now we request the machine-friendly output in the default JSON format, so we can pipe it to a tool like `jq `for detailed inspection.

{{screenshot: drift-06.jpg}}

We can see that *formae* has detected the out-of-band change made to the AWS S3 bucket. The new tag is now part of the resource definition in *formae*.

## Reconcile vs. Patch

You might have noticed we used the `--mode reconcile` flag when applying the forma earlier and wondered what it does. The presence of this flag tells *formae* that you want your actual infrastructure to *exactly* match the desired state defined in your forma Pkl file. Any resources defined in the forma that do not exist in the live infrastructure will be created, any resources that exist in the live infrastructure but are not defined in the forma will be deleted, and any resources that exist in both but differ, will be updated in the live infrastructure.

## Get Jeroen Soeters’s stories in your inbox

Join Medium for free to get updates from this writer.

Remember me for faster sign in

The other mode *formae* supports is `--mode patch`, which allows you to make surgical changes with minimal blast radius. We’ll look at this mode in another article.

## Hard vs. Soft Reconcile

Let’s see what happens when we now try to reconcile from infrastructure code by running the `formae apply` command again — after we detected out-of-band changes.

{{screenshot: drift-07.jpg}}

As you can see, *formae* rejects the operation outright.

This happens because, by default, *formae* attempts to reconcile in the so-called **soft** mode. In this mode, unlike traditional tools that blindly enforce reconciliation from code, *formae* assumes that out-of-band changes might be intentional and important. It guarantees that out-of-bound work — whether it was a hotfix or an experiment — is never silently overwritten.

When *formae* detects this kind of reconciliation conflict, it offers two clear paths forward:

**1. Hard reconciliation:** You can choose to enforce reconciliation from code. By running `formae apply` with the `--force` flag, you perform **hard** reconciliation. This is how the traditional GitOps approach using existing IaC tools works: the manually added tag is discarded, and the infrastructure is reset to exactly match your forma file.

**2. Absorb out-of-bound changes:** Alternatively, you can choose to embrace the change. Since *formae* knows exactly what changed, it provides a `formae extract` command in the output. This command generates the Pkl code that matches the live infrastructure. Let’s run the suggested extract command.

{{screenshot: drift-08.jpg}}

In the resulting code, we see the tag we manually added. You can now incorporate this code into your existing IaC codebase, bringing it back in sync with reality — without losing the out-of-band changes.

{{screenshot: drift-09.jpg}}

We can also choose to do **hard** reconciliation using the `--force` flag and discard the out-of-band changes.

{{screenshot: drift-10.jpg}}

A perspicacious reader might wonder what happens if we make an out-of-band change, and before *formae*’s synchronization job detects it, we make another change via *formae*. No worries, *formae* has your back. Before any destructive update *formae* will always check if the live infrastructure matches the last known state. If it doesn’t, *formae* will reject the command, and it is up to you to resolve the conflict as described above.

## Conclusion

There are many scenarios where out-of-band changes are legitimate. For example, a security team responding to an active incident using their own tools, an infrastructure architect ensuring resources are correctly tagged, cost-optimization tools doing their job etc. Instead of fighting drift, *formae* embraces reality and puts you in control.
