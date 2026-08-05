
Lamis Mukta - Learning while you sleep: Beyond memory to dreaming - AI Native DevCon June 2026


0:00
welcome back. And we have another wonderful session with a topic that is very deep to my heart.
0:07
Sleep. And I'd love to welcome from Anthropic to the stage, please, a warm welcome
0:15
for our next talk.
0:23
Hey, everyone! Great to see you all today and hope you're all having a wonderful day so far here at AI Native DevCon, I certainly am.
0:31
I hope that your context windows are not too full, and you have a bit of space for a little bit more information about context.
0:39
By way of introduction, my name is Lamis. I'm a member of technical staff at Anthropic. I work on our applied AI team, and this is a team
0:47
which sits between research product and go to market. So we do a mixture of working on internal projects as well as directly
0:54
with customers who are building agents at the frontier. Me specifically, I work with startups and founders,
1:01
many of whom I'm sure are in this room today, and I think I have the best seat in the house because these are the users that are constantly pushing us right up
1:10
against the boundary of what is possible with models and products today. And as such, we just get to like, ride the exponential together.
1:20
One thing that constantly comes up, as I'm sure you're all aware, is what it really takes to take the raw model intelligence
1:28
that we have today and translate that into durable, scalable, useful products.
1:34
And one of the main levers that we have in order to do this is context engineering, which will be the focus of my talk today.
1:44
So on this journey, I want to quickly do a recap of where context engineering has gone in the past year.

Image 1: Agenda
WHAT WE'LL COVER
01 Context engineering so far
From prompts to agents that manage their own context.
02 The state of the art in memory today
CLAUDE.md, skills, and the memory directory an agent manages itself.
03 Dreaming up the path to continual learning
Consolidating memory between sessions, out of band.

1:51
It's a space that's completely blown up, and through that, we'll kind of distill the primitives that have proven
1:57
to be really useful, some stuff that has been a little bit less useful. Secondly, we'll talk about
2:03
what the state of the art is for memory management today. And thirdly, and in particular with that, we'll talk about not just what
2:11
nice theoretical principles are, but what it takes to actually build these systems in production. And then finally, we'll talk about where this will go on the path to continual
2:20
learning, and in particular, touching on a paradigm called dreaming.

Image 2: Bottleneck 01
BOTTLENECK 01 · CONTINUAL LEARNING
Intelligence alone doesn't compound
01 Cold start
Every task begins from zero; last run's hard-won context is gone.
02 Domain-specific
What makes an agent brilliant at your work won't just emerge from a bigger model.
03 No compounding
Without memory, task 50 is no better than task 1.


2:26
So we said this before. And models we release new models all the time.
2:33
They are more and more intelligent. But when it comes to actually deploying these models in your agents,
2:38
in your environments, in your organization, the intelligence alone is not going to compound because they need this context
2:45
that helps them perform the specific tasks that you need them to. In particular, a lot of this context is often
2:51
kind of orthogonal to the model intelligence, right? Like the newest model we've just released, one isn't going to
2:59
isn't going to out of the box, know exactly what it takes to succeed in your organization and with the tasks that you want them to.
3:05
And so it's a really great investment to work on the context engineering part, because this over time has the effect of multiplying
3:13
the intelligence even as models get smarter. So I'm sure you'll all be familiar with these problems.
3:18
It's like agents not knowing their way around a code base, or knowing enough about your own user preferences.
3:24
And then additionally, like you don't have the effect where agents are better at the task the next time they perform it, so
3:32
they might not learn from their mistakes. And as such, you don't have this continual learning effect.
3:38
So just to recap. Where we've got so far on this journey of context
3:46
engineering, at Anthropic, we like to say do the simple thing that works.

Image 3: Evolution of Agent Memory
How agent memory evolved
```
CLAUSE.md  →  memory tool  →  skills  →  memory/

# Conventions              memory_read()        pdf/SKILL.md        notes/
- ship: make ship          memory_write()       ---                 deploy.md
# Preferences              memory_edit()        ## Overview         team-rules.md

Single file memory         Memory as a tool     Procedural memory   Files read and 
                                                                    written by agents
```

3:52
And this is a timeline that only really spans the past year. And where we started was with these CLAUDE.md files that we launched with Claude Code.
4:01
And what we learned from this was that it was kind of unreasonably effective, like this markdown file that just gives the agent
4:07
a couple of instructions about maybe your way around the code base, the organization, your own user preferences
4:14
that injected into the beginning of the model's context at the beginning of a session was so good at steering it towards the things that mattered, and helping it navigate
4:22
and align its actions towards your preferences. However, we also learned a couple of things about what doesn't work here.
4:29
So when we're injecting this at the beginning, at the beginning of the session into context, we obviously start
4:34
to run into problems where you get problems with context, like what happens when this file with very important preferences gets very,
4:42
very long. How do I manage that over time? And so we went back to the drawing board and thought about
4:49
ways that we could improve this separately, though what was true was that having just a very simple markdown file,
4:55
which is human readable, which your agent can write, to, which you can write to, is really, really effective.
5:02
So a second avenue that we investigated was these memory tools. And this is interesting because it leans into this idea of okay,
5:12
what happens if we let agents autonomously manage their own memory systems.
5:17
So we let them decide when they read, when they write and when they update memories.
5:22
And this is all happening in band, which means that it's within the context of a session. So during a session, agent is thinking about like
5:31
what might be interesting to pull from memory, what might be interesting to write to memory.
5:36
So autonomy proves to work really well in this case. And over time,
5:42
we've kind of developed that into systems where we're even less opinionated about what these tools need to look like, and I'll touch on that in a second.
5:50
So the next the next stop on this journey was skills, which I'm sure you've had a bunch about today.
5:56
And what this solves is this problem of the ever growing context.
6:01
So we have this really clever idea of progressive disclosure.
6:07
The way I like to think about it is actually first on what skills are good at it's processes where you have like a procedural workflow.
6:15
So something where you have an opinion about how the process works end to end that you want the agent to follow.
6:21
And what's very clever is that the agent only looks at this front matter a couple of sentences at the top of the file before loading the skill,
6:29
but you can still load as much detail as you want into the main body of the file, so you're able to, at the same time,
6:35
have very deep levels of detail whilst not overloading the model's context.
6:41
And the way I like to think about it is as if I had a bookshelf in my room and every time someone talks to me, I can kind of scan
6:49
and look at my list of books and see if any of the titles might be relevant to the conversation, and kind of pick that off the shelf
6:55
and read it when I need to. So, for example, if someone walked up to me and started speaking to me in French and I noticed that I have a French dictionary,
7:01
I could pull that out and it would give me context kind of loaded during the conversation that would help me without me
7:08
having paid attention in like seven years of French classes at school and having that all loaded into my context already.
7:13
So this was a really, really great innovation. But one bottleneck potentially with it is
7:20
that it's still kind of driven by humans and agents together. So you're still even if you're using your agents to write the skills with you.
7:28
You're still being quite opinionated about what things need skills. So that takes me to the final step on this path,
7:35
which is what we perceive to be state of art for memory systems today, and what we have done and what we think is best
7:43
practice is modeling these memory systems just as file systems. So this kind of aggregates a couple of the learnings from this path.
7:51
So file systems are great. You can just fill them up with markdown. Agents are actually just very good at using normal file system tools
7:59
like bash and grep. So just let them search over the file system rather than being opinionated
8:05
about these specific tools that they should use to read and write to memory. And then, yeah, that search kind of mirrors
8:11
this idea of progressive disclosure. You can index these memory systems really well so that agents can intelligently
8:17
search over them. And that's where we have kind of got to so far. So just to
8:23
recap the key linings from that format. Markdown is great for reading memories.

Image 4: Lessons So Far
The lessons so far
Three throughlines across every memory approach that stuck.
📄 Format
Markdown works — everything that stuck relies on human-readable context.
CLAUDE.md · skills · memory/*.md
👁️ Reading
Load progressively — frontmatter and search pull in only what's relevant, never everything at once.
frontmatter + grep, not the whole store
🔄 Writing
Autonomy wins — agents do best when free to record what they deem relevant, how they see fit.
the agent decides what's worth keeping

8:29
You know, allow the memories to grow large, but give agents tools to quickly index and search for what's relevant,
8:36
and finally give agents autonomy when they're writing to memories.
8:42
And if you were to go out and build a system, it would work really well. You would have the feeling of continual learning, because your agents
8:48
would get better at the individual, whatever individual tasks you're doing.

Image 5: Bottleneck 02
BOTTLENECK 02 · PRODUCTIONISING MEMORY
Scaling memory to many, long-running agents in production
01 Concurrent writes
Many agents edit the same memory files at the same time.
02 Lost attribution
Who wrote which memory — you or the agent — and when?
03 Stale & mixed scopes
Org knowledge and working notes tangle; old context pollutes runs.

8:55
However, as with everything, this very neat idea runs into some problems when you try and scale it to production.
9:03
So we have and we have a concept for theoretically what works. And when.
9:09
We then think about scaling these to production in environments where we have many agents collaborating at the same time, where they run over
9:17
very long periods of time, and where potentially these codebases get really complicated, all manner of problems start to arise.
9:26
And we've seen these in production time and time again. So one, a couple of things just to like spark your imagination.
9:33
Think about multiple agents trying to write to a memory file at the same time. How do you manage that?
9:38
Think about one agent running into a problem and deciding to write to the organizational wide context
9:45
which every other agent is currently reading from. Like if something was incorrect there, that would scale
9:50
to all of your agents and be pretty disastrous. And think about when you have humans and agents collaborating on on memory
9:58
contexts together, like how do you keep track of what's going on? The final problem is that memories can go stale.
10:05
Of course, something that was relevant in the past might not be relevant today. Or maybe it was written incorrectly or even maliciously injected
10:13
by someone trying to prompt inject your agents to write bad things to memory. So you have to have a lot of guardrails in place to make sure that these nice
10:23
autonomous memory systems actually work in production.

Image 6
SCALING TO PRODUCTION
Versioning & concurrency
01 Versioning
Every write is attributed to an author, a session, a time — full history to inspect and roll back.
02 Concurrency
A content-hash precondition before each write — living in the harness, not the model.

[Diagram: File Metadata UI]
File: team/deploy.md
version:
    v1, v2, v3, v4•head
written by:
    sesn_011Ca7x...
precondition:
    content_sha256: 9f2c...
content:
    Deploy via make ship, not ./deploy.sh.
    Reason: user corrected this on PRs #412, #418, #431.

10:29
And so I'm going to talk through a couple of key principles that we use when designing memory systems in production to make sure that we do
10:37
get to use all of those nice effects that we've talked, that we've spoken about. So the very first thing is versioning.
10:45
So when you're designing any kind of memory system, you need to be able to store versions
10:50
to keep track of what's going on, to allow you to roll back should you need to, if a new update isn't particularly good.
10:57
Additionally, you probably want to think about what context was this update based on.
11:02
So which agent session? Which transcript resulted in me wanting to make this update?
11:08
And additionally, like you might want to track like who did it, which agent, which human, etc.
11:14
etc.. So this is really important. The second thing is concurrency.
11:19
So we've talked about okay, what happens when I deploy thousands of agents all working off the same memory system.
11:25
And the solution that we've adopted here is to have this hashing system.
11:31
So when an agent decides that it wants to write an update to a memory, it takes a hash.
11:37
It then drafts its edit. And then before it writes the update, it takes another hash.
11:43
If those two things do not match, then the agent cannot write it because it means that some update was made in the meantime.
11:50
And in order to handle that, the agent ripples the memory, drafts its new update, and then tries to commit this again.
11:57
So these are the kinds of just engineering practices that allow you to scale multiple agent architectures, scale memory to these kinds of architectures.

Image 7
SCALING TO PRODUCTION
Built for multi-agent systems
03 Permissioning
Read-only access to shared org knowledge; read-write to an agent's own working memory.
04 Portability
It's just files, with a standalone API on top — memory goes where you go.
[Diagram: Multi-Agent Architecture]
Top Layer (Agents):
Agent A session sess_01
Agent B session sess_02
Agent C session sess_03
Connections: Lines connect all agents to both storage boxes below.
Bottom Layer (Storage):
Box 1 (Left):
Tag: read-only
Title: org-conventions
Files: notes/, style-guide.md, security.md, oncall.md
Box 2 (Right):
Tag: read-write
Title: team-memory
Files: deploy.md, flaky-tests.md, repo-layout.md

12:09
Another couple key principles. So permissions is really important.
12:15
When you have large memory bases you probably have a mixture of top level organizational wide knowledge.
12:21
It might be like your key like what your organization is trying to achieve, or key principles about the code base, which you've really carefully curated
12:31
all the way down to the level of like a scratchpad for an agent, where it writes down its working memory
12:36
and it's very individualized and all the way in between. You can have things for specific organizations or cross sections.
12:44
And so it's really important that you have guardrails when it comes to permissions, these memories.
12:49
So like I said, you wouldn't want one agent to just decide that it should update the organization wide context.
12:55
Probably you might want that as read only. However for its own scratchpad, you would want it to have right access
13:01
and yeah. Yeah that's that's permissions.
13:08
The final thing which is kind of peripheral but still really important when you design memory systems is portability.
13:16
So like I mentioned before, your curation of your memory
13:22
systems is going to be so important like throughout the future. This is really really important organization user
13:29
or like work task specific context. And so it's likely that if you're putting a lot of effort into curating this,
13:36
you want it to be accessible across potentially multiple product surfaces and access accessible by multiple systems.
13:45
So designing it in a way with a clean API in which it's portable and you can access it is really important.
13:51
And so when you put all these things together, we have the kind of learnings we have from allowing agents
13:58
to creatively manage their memory, and then these production level guardrails that allow them to reasonably use all of those principles in practice.

Image 8
IN PRODUCTION
What teams see with memory

Card 1
97% fewer first-pass errors
"Memory lets us put continuous learning into production at scale — at 27% lower cost and 34% lower latency, and learning stays under our control."
GM, AI for Business
Global commerce platform

Card 2
30% faster verification
"In our document-verification pipeline, cross-session memory lets agents remember common issues — including ones we didn't think about."
Head of Machine Learning
Document-AI platform

Card 3
Focus on the product
"A lot of our work is making sense of fast-moving, messy conversations between teams and their agents. Memory lets us stop building memory infrastructure and focus on the product itself."
Founder
Early-stage AI startup

14:07
And when you do this, you get very effective results. So just sharing here a couple of learnings from what we've seen,
14:14
deploying these large scale memory systems in production. And for example we see you get better accuracy.
14:23
So you have this effect where the second time the agent does the task, it actually does it better with higher results,
14:30
because it's noted all of those memories about what went wrong. Secondly, that then has second order effect on the speed and latency, sorry,
14:39
speed and cost of your agents running because then spending fewer tokens, they can be more easily one shot to these tasks because
14:47
they actually know what they're doing. And you'll see that across all sorts of different processes, agents are just able to do the task better and faster.
14:55
Finally, having this process where your agents are starting to autonomously write their own memories frees up capacity
15:04
and context for you as product developers, potentially to focus on product wins. While you know that the agents are doing
15:10
this kind of self-learning continual learning loop in the background, and once that infrastructure is set up really well,
15:17
this this works very symbiotically.

Image 9
BOTTLENECK 03 · MEMORY OVER TIME
In-band memory reaches its limits
01 Split focus
Every session the agent divides attention between finishing the task and maintaining memory — a difficult optimisation.
02 Patterns obfuscated
Agents writing to memory in-band miss patterns from across sessions and across different agents.
03 Memories go stale
Duplicates that disagree, notes gone stale — confidently wrong.

15:23
As ever. We do then reach a new bottleneck. And this specifically is about in-band memory.
15:30
So in-band memory as I mentioned before, is when agents are writing to and reading from memory within a specific session.
15:39
So if you think about Claude code for when you spin up a new session,
15:44
it's it's largely like focusing on that specific context when it's reading to reading and writing from memory.
15:51
And this just architecturally or philosophically has limitations in the general like agent fleet's continual learning objectives.
16:00
There's two, two main reasons why, first of all, is that you have this inherent split of focus and resources.
16:06
So you're asking an agent to complete a task, but at the same time, you're also asking it to invest in memory curation, which would help it
16:15
perform better in a future run. So when you put these things together, it's just a very difficult
16:20
optimization problem. Because how much capacity should an agent put into helping future versions of itself versus doing the task that you actually asked it to do?
16:29
And also there's like other effects like latency, for example. The second thing is that
16:35
the agents just have an inherent visibility limitation. So they only have the context of what's going on in their session.
16:43
As such, they just won't see patterns that happen across sessions. So when you get frustrated that your agent keeps making the same mistake over
16:50
sessions, it just doesn't understand how frustrating that is because it has a new context window in each of those.
16:56
Secondly, when you're running multiple fleets of agents in different environments, you these single agents just don't have the context
17:02
of what other failures other agents are running into. So for these two reasons, we introduce this concept of some out-of-band
17:09
memory curation. And this helps to make these problems go away. And just to introduce an analogy for why this in theory should work,
17:20
I'd like you to think about a school, for example, where you have lots of students that submit a lot of work,
17:25
and you also have teachers at market and a head teacher that reviews everything.
17:31
This is a system that we have in the real world for good reason. And it's because when you have certain individuals that have dedicated capacity
17:39
for helping people learn, that's really effective. And when you also have people that have visibility over the whole fleet of agents or learners,
17:46
and they're able to spot patterns and then kind of steer context or let's say in this case, the curriculum that's also really effective.
17:53
So as always, we kind of look to the real world world to think about how to build these systems.
18:00
Sorry, I also didn't touch on a final limitation, which is that memories go stale. So you need something some pass that checks that

Image 10
The resolution
A second-order process
Introducing Dreaming
A batch process that runs out of band — with a single objective of curating memory.

18:07
everything that's written there is still correct. And so we introduced this concept of dreaming,
18:15
which is like a second second order process over memory. So if we think about how that's been constructed we have the like
18:23
actual context which agents reference and has useful information, the memory processes which allow agents to kind of autonomously manage
18:32
that context themselves. And then dreaming, which is a process that runs in batch and asynchronously
18:39
with its own allocated resources to ensure that those memories themselves are effective up to date, and helping the agents
18:47
learn over time.

Image 11
How dreaming works

[Diagram: Flowchart]

Input: "Transcripts from agents' daily sessions" (represented by four "Agent" blocks).

Process: Arrow points down to Dreaming ("Periodic batch process").

Output: Arrow points down to Updated memory state containing:
New insights
Organized structure

Feedback Loop: Arrow points from "Updated memory state" back up to Your agent's memory state.

Result: "Next day's agent sessions are automatically more intelligent".

18:52
So what does dreaming look like? Essentially, what we do is we take an existing memory store.
19:00
So this is a collection of memories. We then take a bunch of sessions or transcripts
19:07
from agent interactions over a period of time. And we give these together to an agent, which reviews all of the transcripts,
19:16
looks at the memory store, and starts to identify patterns for where there could be uplift in the memories.
19:25
It then outputs a new memory store, whether it proposed changes to the existing memory store
19:32
and what the agent is able to do, as I mentioned, is spend tokens on solving this problem of making agents learn better.
19:40
Identify patterns for where agents are consistently failing, and then proposed changes for what might make a more effective memory store,
19:48
such that next day when you run these agents again, they're actually feel smarter and they're running better.
19:55
To go back to my analogy, just to paint some pictures of like what this could look like in practice, let's imagine that the head teacher reviewing all these transcripts
20:05
notices that every geography student has incorrectly answered a question. They're just all writing like complete garbage.
20:11
To this question, the teacher notices that actually by kind of in this case,
20:18
analyzing the memory store, that entire topic is missing from the curriculum. So while the teacher is able to do is notice that pattern,
20:25
look at the memory store and suggest a new change to that curriculum such that the next day when these agents run,
20:30
they now have that information that they needed. To give another example, the teacher might notice
20:36
that in a certain maths exam, all of the answers are wrong. In the same way, all of the students are outputting radians
20:43
when it's meant to be degrees. I don't know if anyone else in like GCSE maths had that problem too,
20:48
but what they're able to do is give an instruction saying like, this is how you should configure your calculators.
20:54
And in the case of agents, that's like noticing in the transcripts that there's something wrong with the tool configuration.
21:01
So you might notice that something in the tool calls keeps failing. And what's important here is that when we look at those transcripts,
21:09
we are not just looking at kind of the passes of like responses between agent and the system or the user.
21:16
We're also really scrutinizing those tool calls and all of the other metadata that is really central to the agent's performance.
21:24
Finally, you could also notice something that's like fleet wide or organization wide. So for example, like everybody is using too many dashes and you don't like that.
21:32
So you want to add some organizational wide announcement or context change that says not to do that.
21:40
And so I hope that paints a picture of why this could be really, really effective. And now I'll just talk about
21:47
how you would go about designing such a system in production.

Image 12
Inside a dreaming pass

[Diagram: Process Flow]

Step 1 (Clone): `Input memory store` ($MEM) is cloned to `Output memory store` ($MEM_OUT).

Step 2 (Dispatch): An `Orchestrator` spawns a `Subagent` for each session ("one per session").
`Session 1 transcript` → `Subagent`
`Session 2 transcript` → `Subagent`
`Session 3 transcript` → `Subagent`

Step 3 (Reorganize): Subagents perform `read / write to reorganise` directly into the `Output memory store` ($MEM_OUT).


21:53
So you have some concept of your memory store, which is a concept which is a collection of memories.
22:00
Memories themselves might just be marked down files organized in this directory.
22:05
You then take a number of the transcripts. And like I mentioned, that is a mixture of like the back and forth passes
22:13
between the agents as well as metadata on tools, other skills they used, etc.
22:19
and the way that we've designed it, we have the orchestrator deploy a fleet of subjects that go and analyze all those transcripts.
22:27
And one point worth making here is that when you design these systems, you have the ability to steer how these agents,
22:35
which both write memories and coordinate dreaming, go about the problem. And by steering I mean that you're able to tell them, like
22:42
in your specific case, these are the kinds of things I think are important and relevant. These are the kinds of things that are not important and relevant.
22:49
So you do have the ability there to start to curate that memory and dreaming process to your organization specifically.
22:58
And the orchestrator then reviews all of the responses from the subjects.
23:03
And it then decides like where there are prevalent enough patterns, that it thinks this warrants a change in the memories.
23:12
From there, it proposes individual changes to the memory store and in our case, the way that we've designed this in production is
23:21
the agent will additionally give you of transcripts where it's noticed this pattern has happened,
23:26
and also some stats on like how prevalent this issue is and why this warrants actually updating the memory store.
23:35
And so all of this works really neatly. You get this output and you as the individual can decide where
23:42
you want to accept changes to the memory, where you want to reject them, etc. and this works really effectively.
23:52
So together we have these two processes that run in parallel.



Image 13

**A unified memory system**

**[Diagram: System Architecture]**

*   **Left Side (Memory - Real-time updates as agents work):**
    *   Agents (A, B, C) in sessions (`sess_01`, `sess_02`, `sess_03`) interact bidirectionally with `team-memory`.
    *   `team-memory` contains: `deploy.md`, `flaky-tests.md`, `repo-layout.md`.
*   **Right Side (Dreaming - Periodic batch updates between sessions):**
    *   `Session transcripts` feed into the `Dreaming` process.
    *   `Dreaming` performs: **Verify**, **Organize**, **Enrich**.
    *   `Dreaming` interacts bidirectionally with `team-memory`.



23:58
The first is memory. And these agents are using
24:03
some of their like in-band context and in-band resources to write to memory where they think it's important.
24:11
And this is neat because it means that in the actual next run, the next session, that agent will be better.
24:17
So there's a shorter time to kind of seeing that change. But inherently these agents have competing resources
24:23
when they think about what to dedicate to memory, what to dedicate to completing the task, and additionally a lack of visibility.
24:31
So on the other side, we have dreaming, which is this out-of-band process.
24:36
And this allows, again broader visibility and dedicated capacity, i.e.
24:42
token spend, which is specifically directed towards helping agents learn better.
24:48
And you might think, okay, that sounds really expensive. Why would I want to chuck extra resources at this?
24:54
But if we kind of go back to the improvements we saw when you build effective memory stores, actually you can see a bunch of costs go down
25:02
because agents are able to one shot things more effectively. They have more information that they need in order to perform a task well.



Image 14

**Three takeaways**

**1. Do the simple thing that works**
*   A good CLAUDE.md, well-defined skills, and agent-written memory already get you a long way.

**2. Design for many, long running agents**
*   Productionising to a fleet? Permissioning, versioning, concurrency, and portability.

**3. Add dreaming to consolidate memory out of band**
*   Consolidate and curate memory out of band — verify, organise, enrich between sessions.
*   

25:14
So to summarize. At the very least, do the simple thing that works.
25:21
Context management makes such a huge difference to your agent performance.
25:27
Implementing things like a CLAUDE.md file like skills, which I'm sure you've heard about a bunch, and allowing agents
25:34
to autonomously manage these systems themselves goes a really long way. Once you think about scaling those things into architectures
25:42
with many agents, agents that run over a very long time,
25:48
situations where you will continue to work and develop on a workspace or code base over a long period of time
25:54
or very complex domains, you should start thinking about adding some features or some guardrails that allow those agents
26:01
to manage their memory in a way that is safe, verifiable, auditable.
26:07
I should also say here that whilst this kind of these kinds of practices
26:13
are really effective when it comes to coding task, for example, this by no means is just specific to coding.
26:19
Like I use memory all the time when I'm producing presentations. It has context on like how I like to write things, how I like my slides, etc. etc.
26:26
and that develops over time. So this is really not coding specific. The final thing is
26:33
if you really want to kind of close the loop here. Think about adding an additional out of band process like dreaming as we call it,
26:40
to consolidate your memory and cut things that are no longer relevant. Add things that agents are missing and clean up and organize memory systems.
26:52
So to close, I want to say that this journey that we've been on with context
26:57
engineering, a lot of this stuff has only happened in this past year. This is very much an open area of research
27:04
and development, and one in which we see huge value in the future. So we're so excited to see the kinds of things
27:10
and contributions that you all make to this space. So I encourage you to keep thinking, keep learning and keep dreaming.
27:17
Thank you.
27:26
Thank you. That was great. Do we have any questions in the room? Oh, golly gosh.
27:31
I'll dive straight here first. Thank you. Thanks for the presentation.
27:38
Do you have any memory store implementation that you would like
27:43
to suggest? Any any memory storage implementation that you would like us?
27:49
Sorry. Did you say. Papers or no. Memory storage implementation? Okay. Okay. That we'd like. To suggest.
27:56
To solve what problems specifically? Well, one thing is put things in files that I have on my laptop,
28:04
but I think I'm looking into something more enterprise. So what kind of solution do you suggest over there?
28:12
Okay. Yeah. So. I mean, maybe I was kind of coining the talk because we're not allowed to make product call to actions.
28:18
But given that you asked. We have a lot of this references.
28:25
The architecture that we used in our memory, our memory infrastructure for our managed agent solutions.
28:33
And so when I talk about these things about production memory, so everything like versioning,
28:39
hashing, etc., that's all available within our memory and dreaming API through Claude Managed agents.
28:45
So if you did want an outer box solution for this kind of thing, that is where I would point you to.
28:55
The early on. You talked about guardrails and permissions, and I think, sure,
29:01
most of us have probably read the Claude code leak and the memory stuff. The dreaming stuff was definitely some of the most interesting in it.
29:07
But how do you scale that at enterprise if you've got hundreds of users with different permission sets?
29:14
How do you make sure dreaming follows those same guardrails? If it's happening out of band and the context is different compared to,
29:23
say, the context the agent might have when a user is using it.
29:28
So just to check that I understand we have like some permissions about what agents can access like in terms of memory.
29:36
And then a separate like. Yeah. So I mean I think these things compose quite well because when you set up
29:43
a dreaming procedure, you decide exactly which session transcripts to attach.
29:48
And so you could build a process which mirrors whatever permission you have on the agent's. So yeah, I mean, if that's to say that
29:57
it's not the case that when you kind of trigger a dreaming job, it just takes like everything in a certain time period. You can configure it that way.
30:03
But you could also just search over whichever transcripts have the same permission set as, like whatever your memory store is,
30:10
and then make sure that that matches, if that makes sense.
30:16
Hi. Thank you. This was really, really interesting. I found it fascinating earlier when you were mentioning about like
30:21
versioning, concurrency, durability, all these things. At what point are we like reinventing databases
30:27
from first principles again?
30:33
Yeah. This is this is an interesting point. I still think like one of the things that I
30:41
this is a good reminder for me that something I didn't say, what we're trying to do here is like, thread the needle like,
30:47
sorry, find the right boundary to draw between kind of letting these agents autonomously act and then also like which things should just be kind of
30:55
programmatic things that are baked into the harness. And so I think what you allude to is like,
31:02
first of all, we were just kind of like letting these agents write in markdown files and just like commit whatever they wanted. And now we're kind of seeing,
31:08
having seen which primitives work really well with thinking about like kind of codifying that in the harness. And so when we think about like
31:14
the hashing or the versioning, yeah, we are kind of going back to the software engineering principles that we've seen work well in the past,
31:19
but in a way that kind of autonomous agents can act and like can can interact with those really effectively.
31:27
So I think to some extent, like we sort of are merging back into those practices.
31:32
But that's because we have enough signal now to know that those things should just be done in a very deterministic way, and there's no need to reinvent the wheel.
31:39
I hope that answers your question. Perfect. We're absolutely out of time. Thank you. Once again.
31:45
Big round of applause for. Thank you.





