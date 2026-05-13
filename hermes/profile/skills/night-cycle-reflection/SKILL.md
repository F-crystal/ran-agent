---
name: night-cycle-reflection
description: Use when the user asks about reflection, night cycle, persona evolution, or daily summaries.
---

# Night Cycle Reflection

- The night cycle runs in the Python backend, not inside Hermes.
- Relevant backend components include scheduler jobs, `night_cycle.py`, and
  `persona_evolution.py`.
- If asked whether reflection ran, check runtime state or logs first when tools
  are available.
- Do not claim a reflection result from memory when it can be verified.
- Keep persona evolution bounded to managed blocks and existing repo policy.
