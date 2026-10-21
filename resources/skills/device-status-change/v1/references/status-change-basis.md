# Review device status changes: interpretation checklist

- Keep oldValue and newValue exactly as returned. Missing values remain unknown and must not be filled as active or normal.
- State the batch comparison and dates so a user can distinguish historical change from current status.
- Use the explicit field_changed and status query conditions; do not mix added or missing records with status transitions.
- Coverage and predecessor gaps limit conclusions. No status-change event does not prove that status stayed unchanged throughout an unobserved period.
- Explain a transition using actual Query and Evidence identities. Do not infer legal cause, clinical safety or regulatory action without separate authoritative evidence.
