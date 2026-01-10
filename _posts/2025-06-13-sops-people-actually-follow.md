---
layout: post
title: "SOPs That People Actually Follow: Turn a messy process doc into a spoken checklist (and test it by ear)"
date: 2025-06-13
author: "Nick Daly"
slug: sops-people-actually-follow
permalink: /blog/sops-people-actually-follow/
categories: [blog]
tags: [Operations]
---
Most SOPs don’t fail because the process is complicated.
They fail because the document is doing the wrong job.
It’s trying to be:
* a training guide
* a knowledge dump
* a justification memo
* a record of history
* and a checklist
…all at the same time.
So when someone actually needs it—mid‑task, under time pressure, half‑distracted—they bounce off it. They improvise. They Slack a coworker. They “do what we did last time.” And suddenly you have three versions of the same process, plus a mystery bug no one can reproduce.
A simple way to tighten an SOP is to turn it into something you can **hear**.
Not because people want to listen to policies like a podcast, but because listening forces structure. It makes missing steps, vague instructions, and “magic happens here” sections painfully obvious.
With a paste‑and‑listen tool like Read‑Aloud, you can run a fast SOP QA loop:
**copy the SOP section → paste → press Start → listen for the holes**
Then rewrite into a spoken checklist that’s actually executable.

## Why “written like a document” breaks “used like a process”
Here are the patterns that make SOPs look professional but behave poorly in real life:
## 1) “Narrative paragraphs” instead of steps
A paragraph can be informative and still unusable. When you’re doing the work, you don’t want prose. You want the next action.
## 2) Hidden prerequisites
The doc starts at Step 1, but Step 0 is actually:
* you need access
* you need a tool installed
* you need last month’s report
* you need a template link
* you need to be on VPN
If those aren’t stated up front, the SOP feels like it’s lying.
## 3) Vague verbs
“Review,” “check,” “validate,” “ensure,” “handle,” “coordinate.”
These are the words that create plausible deniability.
What does “review” mean—skim it, verify every row, compare to a source of truth, spot-check five items?
## 4) The “exception trap”
The SOP describes the happy path, then tacks on exceptions in parentheses or footnotes. Exceptions are usually where the real time goes.
A usable SOP doesn’t hide exceptions. It labels them.
## 5) No definition of done
A step says “submit the request,” but doesn’t say:
* where submission is confirmed
* what “success” looks like
* who signs off
* what to do if it fails
So people finish the step and still don’t know if they’re finished.

## Why listening is a great test for SOP quality
A good SOP is sequential. You do steps in order. That’s exactly how audio works.
When you listen, your brain asks the questions that matter in execution:
* “Wait—where am I doing this?”
* “Which file?”
* “What does ‘correct’ look like?”
* “How do I know I didn’t break anything?”
* “What if the option isn’t there?”
And here’s the key: **your eyes will often forgive missing structure because you can jump around.**
Your ears won’t. If the doc relies on jumping around to be understandable, it’s not a great SOP.

## The “Spoken Checklist” format (the one that gets used)
If you want an SOP people actually follow, write it in sections that match how people think mid‑task:
1. **Purpose (1–2 sentences)**
2. **Before you start** (tools, permissions, inputs)
3. **Steps (numbered)** — one step = one action
4. **Decision points** (if/then)
5. **Definition of done** (how to verify success)
6. **Common failure points** (what usually goes wrong)
7. **Escalation / owner** (who to contact, what to include)
This isn’t bureaucracy. It’s empathy for the person doing the work on a Tuesday afternoon when three other things are on fire.

## The SOP “by ear” audit (copy → paste → listen)
Here’s a practical 8-minute workflow you can use immediately.
## Step 1: Copy only the section someone would follow
Don’t start by pasting the whole SOP. Start with one workflow block: the steps, the approval section, or the “how to run this weekly” section.
If the SOP includes sensitive info (passwords, keys, secret URLs), paste only the parts you need and keep secrets out of the listening copy.
## Step 2: First listen at 1.0× (flow + gaps)
Paste into Read‑Aloud. Speed at **1.0×**. Press Start.
As you listen, tag the text with quick brackets:
* **[missing prereq]**
* **[unclear step]**
* **[what tool?]**
* **[too much in one step]**
* **[how do I verify?]**
* **[what if it fails?]**
If you find yourself wanting to pause and re‑read, that’s not you being impatient. That’s the SOP being unclear.
## Step 3: Rewrite into numbered steps (one verb each)
Now convert the messy parts into steps that sound like commands a competent colleague would give you.
A good step starts with a concrete verb:
* Open
* Download
* Create
* Paste
* Rename
* Run
* Compare
* Confirm
* Notify
* Archive
If you can’t start the step with a clear verb, it’s probably not a step yet—it’s explanation.
## Step 4: Second listen at 0.9× (precision)
Now paste the rewritten checklist back into Read‑Aloud at **0.9×**.
This pass catches:
* steps that are still too long
* missing “where” details
* pronouns that don’t point to anything (“this,” “that,” “it”)
* verification steps that don’t actually verify
If a step sounds annoying to hear, it’s often annoying to do.

## A real before/after example (what this looks like)
## Before (looks fine, fails in execution)
“After the report is generated, it should be reviewed for accuracy and any anomalies should be investigated. Once confirmed, the report can be shared with stakeholders and the ticket should be updated accordingly.”
If you’re doing the work, that paragraph is basically four questions disguised as one paragraph:
* reviewed how?
* what counts as an anomaly?
* who are the stakeholders?
* what do I write in the ticket?
## After (spoken checklist)
**Before you start:** you need access to the reporting dashboard and the current stakeholder list.
1. Generate the weekly report in the dashboard.
2. Compare the top-line totals to last week’s report.
3. If any metric changes by more than 10%, write one sentence explaining why (or mark it “unknown”).
4. Confirm the report includes the correct date range (Monday–Sunday).
5. Export to PDF and save as: Weekly_Report_YYYY-MM-DD.pdf in the shared folder.
6. Post the report link in #analytics-updates and tag the stakeholders listed in the SOP.
7. Update the ticket with:
    * link to the file
    * any anomalies and explanations
    * your name + timestamp
**Definition of done:** report is posted, ticket contains link + anomaly notes, and the file is saved with the correct name.
That version is boring in the best way. It’s executable. It creates proof. It reduces rework.

## The “If you can’t do it while listening, it’s not done” test
Here’s a tough but useful test:
Imagine someone is doing the process with their eyes on the tool (dashboard, spreadsheet, admin panel), and the SOP is being read aloud in the background.
If the person would need to stop every 15 seconds to ask, “Wait—what exactly do I click?” the SOP is still missing concrete instructions.
This doesn’t mean you need to narrate every click. It means you should include the details that remove ambiguity:
* exact page name
* file naming convention
* where outputs go
* what success looks like
* what to do when something doesn’t match

## The spoken checklist template (copy/paste)
Use this structure as your default. It’s intentionally short.
**Purpose:**
(What this process achieves in one sentence.)
**Before you start:**
* Tools:
* Permissions:
* Inputs:
* Time expectation:
**Steps:**
1)
2)
3)
**Decision points:**
* If ___ happens, do ___.
* If ___ is missing, do ___.
## Definition of done:
*
## Common failure points:
*
**Escalation / owner:**
* If blocked, contact ___ with: (screenshot / link / error text)

## The final checklist (run it before publishing an SOP)
☐ Steps are numbered and start with concrete verbs
☐ Prerequisites are listed up front (tools, permissions, inputs)
☐ Each step has one clear action (no “do A and B and C” in one line)
☐ Vague verbs (“review,” “ensure”) are replaced with checks you can actually perform
☐ There’s a definition of done (how you verify success)
☐ Exceptions are labeled as decision points (if/then)
☐ I listened once at 1.0× to find gaps
☐ I listened at 0.9× to catch ambiguity and pronoun confusion

A lot of teams think SOP problems are cultural. Sometimes they are. But often the SOP is just structurally unfit for how people use it.
Turning it into a spoken checklist—and testing it by ear—is a fast way to make your process docs real. Not “nice to have,” not “we should update this someday,” but something a smart person can follow correctly the first time, even when they’re busy.
