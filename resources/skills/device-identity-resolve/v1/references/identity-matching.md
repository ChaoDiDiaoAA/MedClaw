# Resolve a device identity: interpretation checklist

- Choose matchBy from the identifier supplied by the user. Preserve the literal search text rather than manufacturing a normalized identifier.
- A fuzzy or partial name match is a candidate, not an assertion that records describe the same device. Use returned identity fields to explain the distinction.
- Use the resolution returned by the tool and inspect pagination. Do not select the first item simply to make a downstream query possible.
- A device view supplies identity information within product scope. Current snapshots and change events require their own queries and evidence.
- If permission or input identity checks fail, keep the question unresolved. Do not search unrelated Sessions or read author files to obtain business data.
