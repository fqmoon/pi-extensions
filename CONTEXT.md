# Whereami Domain Language

Whereami helps an agent re-orient during long tasks and makes its progress checkpoints visible.

## Language

**Checkpoint**:
A recorded point in task progress that captures the agent's current abstraction level, scope, understanding, and next action. It does not imply that a stage or objective has been completed; the latest checkpoint and checkpoint count refer to progress since the most recent actual user message.
_Avoid_: Milestone, completed stage

**Re-orientation check**:
An opportunity for the agent to reassess where it is and whether its current path remains informative. A check may finish without producing a valid checkpoint.

**Decision turn**:
One completed main-task model response, regardless of how many tools it calls. A requested response devoted only to collecting a checkpoint is not a decision turn.
