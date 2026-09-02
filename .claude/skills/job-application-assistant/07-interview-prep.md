---
framework_version: 1.0.0
---

# Interview Preparation Guide

<!-- SETUP: STAR examples are personalized by running /setup based on your actual experience -->

## STAR Format

Structure answers as: **Situation** (context), **Task** (your responsibility), **Action** (what you did), **Result** (outcome).

Keep answers to 1-2 minutes. Be specific. End with what you learned or would do differently.

## Ready-Made STAR Examples

<!-- These are populated by /setup from your actual experience. -->

### 1. PPE Detection Android App (End-to-end ML ownership)
**S:** Workplace safety monitoring is usually manual or requires expensive fixed CCTV+AI systems; wanted to prove a lightweight mobile alternative was possible.
**T:** As a self-initiated prototype, design and ship a complete Android app that detects PPE compliance (helmet, vest, glasses, shoes, gloves, mask) in real time on-device.
**A:** Trained a YOLOv8n model on 5,000 annotated images across six safety categories, converted it to TFLite for mobile inference, and optimized the final Android package down to 55MB for practical deployment.
**R:** Achieved mAP50 of 0.801 and mAP50-95 of 0.561 - production-viable accuracy - in a self-directed project with no team or budget.
**Use for:** "Tell me about a project you built end-to-end", "How do you approach a technical problem with no clear spec?", "Give an example of applied machine learning"

### 2. INSAMO AI Water-Level Prediction (Data-driven engineering)
**S:** The disaster mitigation center at ITS needed a way to forecast flooding risk in Surabaya from existing sensor data, rather than reacting after water levels rose.
**T:** As AI Engineer on the project, build a predictive model and translate it into an actionable flood-risk simulation.
**A:** Processed 148 days of historical sensor data, built a forecasting model for the next 30 consecutive days, and integrated the predictions into an urban flood simulation to estimate peak water levels for Surabaya.
**R:** Delivered a model with a Mean Absolute Error of 5cm - accurate enough to feed directly into the simulation and warning pipeline.
**Use for:** "Describe a time you worked with real-world, messy data", "Tell me about a project with measurable impact", "How do you validate a model's accuracy?"

### 3. Autonomous Trash Skimmer Ship (Hardware under real constraints)
**S:** The National Ship Design and Engineer Center at ITS needed a working autonomous vessel for aquatic waste collection, combining propulsion control with sustainable power.
**T:** Own the electrical systems: remote control for propulsion/maneuvering and the vessel's power system.
**A:** Designed a remote control system enabling precise thruster power regulation and autonomous navigation, and engineered a solar-integrated electrical system built to sustain 3 hours of continuous operation.
**R:** Delivered a functioning autonomous vessel with a verified 3-hour continuous operating window on solar power alone.
**Use for:** "Tell me about a hardware project with real constraints (power, cost, reliability)", "Describe a time you worked on a team-built physical system"

### 4. Landslide Early-Warning System (Resource-constrained engineering)
**S:** Early warning systems for landslides are often expensive and inaccessible for the communities that need them most.
**T:** Design and build a low-cost early-warning device that stays accurate despite the tight budget.
**A:** Implemented a Fuzzy Logic detection and prediction algorithm running on an ESP32 microcontroller, deliberately choosing components and methods to keep the full system under an IDR 1,000,000 budget.
**R:** Delivered a working low-cost landslide detection and prediction system, demonstrating that accessible hardware can still support genuine early-warning accuracy.
**Use for:** "Tell me about a time you had to work within a tight budget/constraint", "Describe a project where cost was a hard requirement, not an afterthought"

### 5. Head Manager, BSO SENERGY DTEO (Leadership & mentoring)
**S:** BSO SENERGY DTEO is a student organization focused on renewable energy and technology advancement, and needed active leadership to stay effective.
**T:** As Head Manager, lead a 13-member team and support members' technical growth.
**A:** Led the team day-to-day, served as competition mentor for the OLIVIA 2025 preparation team, and acted as subject matter expert for a Basic Electronics workshop, training 60 students in fundamental engineering competencies.
**R:** Sustained an active 13-member organization and directly upskilled 60+ students through hands-on technical training.
**Use for:** "Tell me about a time you led a team", "Describe your experience mentoring others", "How do you balance leadership with individual technical work?"

### 6. Maintenance Industrial Quality Internship (Working within an existing company system)
**S:** PT. Evoluzione Tyres (a JV between Pirelli and Astra Otoparts) needed better visibility into machine KPIs and a smoother maintenance workflow, in a live industrial environment with existing systems and stakeholders.
**T:** As the Maintenance Industrial Quality intern, build a fullstack monitoring and workflow tool that plugs into the plant's existing operations.
**A:** Built a fullstack Next.js application with a real-time KPI machine-monitoring dashboard and a maintenance staff portal (report exporting, approval workflows, role-based permissions, digital signatures, dynamic form builder), integrating SQL Server and server-side cron jobs for reliable 24/7 monitoring.
**R:** Delivered a stable, continuously running monitoring and workflow system used by maintenance staff in a live industrial setting - first experience shipping software into an existing company environment rather than a self-directed prototype.
**Use for:** "Tell me about working within an existing company's systems/constraints", "Describe your most recent professional experience", "How is working in a company different from your personal projects?"

<!-- Add more STAR examples as needed. Aim for 4-6 covering different competencies. -->

## Common Tough Questions

### "Why did you leave [previous company]?"
> My internship at PT. Evoluzione Tyres (J.V. Pirelli - Astra Otoparts) was a fixed-term placement running through August 2026, and it's concluding on schedule. It gave me real fullstack and industrial-operations experience, but I'm specifically looking for my next internship to go deeper into AI/IoT and embedded engineering, which is the direction I want to build my career toward.

### "You don't have [specific skill/experience]."
> That's fair - I haven't worked in a team with formal testing, CI/CD, or code review processes yet; my projects so far have been fast, self-directed builds. I pick up tools quickly (six different hardware/software stacks in under two years) and I'm specifically looking for this internship to learn professional engineering discipline from a team that already has it.

### "Where do you see yourself in 5 years?"
> Working full-time as an AI/IoT or embedded systems engineer, ideally having converted from a strong internship into a full-time offer, shipping production systems rather than prototypes, and mentoring newer engineers the way I've mentored students in my current organization.

### "What's your biggest weakness?"
> I default to building fast and solo rather than following a structured process - it works well for prototypes but isn't how production engineering teams operate. I'm actively addressing it by seeking an internship on a team with established practices, specifically to build that discipline.

### "Why this company specifically?"
> Customize per company. Must reference: specific projects, company values, market position, or team structure. Never give a generic answer.

## Questions You Should Ask Interviewers

### About the Role
- "What does a typical week look like in this role?"
- "What would success look like in the first 6 months?"
- "What's the biggest challenge the team is facing right now?"

### About the Team
- "How big is the team, and how do you divide work?"
- "What does the development/project lifecycle look like, from idea to production?"
- "How do you onboard new team members?"

### About Tech & Growth
- "What's your current tech stack for [relevant area]?"
- "Is there room to grow into more architectural or strategic decisions?"
- "How does the team stay current with new tools and methods?"

### About Culture (use these to prevent disappointment)
- "How would you describe the team culture?"
- "What does professional development look like here?"
- "Is there flexibility for remote/hybrid work?"
- "What's the balance between development/new projects and maintenance work?"
- "How would you describe the leadership style in this team?"
- "What do people who thrive here have in common?"

## Phone/Video Interview Tips
- Have STAR examples written out (use this file)
- Keep a glass of water nearby
- Smile when speaking (it changes your tone)
- Ask for clarification if a question is vague
- It's OK to take 5 seconds to think before answering
- End with: "Is there anything else you'd like to know about my background?"

## After the Application (Best Practice)

### Follow-Up Etiquette
- **Don't call to "stand out"** or to learn more about the role post-submission - this risks a negative impression
- If the employer specified a timeline, respect it and wait
- If no timeline was given and significant time has passed (2+ weeks), a brief call to ask about status is acceptable
- If you have genuinely new, relevant information to share, a short follow-up is fine

### Thank-You Notes
- When you receive any update (interview invitation, rejection, or status update), send a brief thank-you message
- Express appreciation for their time and the process
- Keep it short (2-3 sentences)

## Roleplay Guidelines
When the user asks for interview practice:
1. Ask which role/company to simulate
2. Start with easy warm-up questions ("Tell me about yourself")
3. Progress to role-specific technical questions
4. Include 1-2 behavioral questions using the competencies from the job posting
5. End with a tough question or curveball
6. After each answer, give brief feedback: what worked, what to sharpen
7. Suggest which STAR example would work best for each question
