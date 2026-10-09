# Stage 2C1a: Home Energy Plan card preview

`HomeEnergyPlan` keeps its existing `plan` as the default. Optional `alternatives`
contain a stable unique `id`, display `label`, explicit `timeZone`, and a Stage 2B
canonical resolution or offline E.ON result. Supply approved data explicitly;
this stage supplies no production alternatives and imports no fixtures into the
application. The page and all other dashboard consumers remain unchanged.

The source selector appears only when alternatives are supplied. Selection is
local React state, unsaved, and requires a deliberate action. Removing a selected
source shows unavailable presentation until the user explicitly returns to the
configured plan; it never silently falls back. Alternative IDs must identify
stable sources. Labels are source metadata, not evidence of verified economics.

For previews, the unchanged `selectedHomeEnergyPlan` boundary supplies both the
view and `presentationSignal`. Summary, cheap periods, timeline, Details windows,
conditional descriptions and window provenance use those validated outputs.
The raw inspection signal is never rendered. Unknown export remains independent
of import, gaps remain unknown, and SMART opportunities remain conditional.
Unavailable presentation shows a safe explanation with no prices or timeline.

Every preview states: “Home Energy Plan preview only; other dashboard insights
retain their current source.” The existing server-generated plan timestamp seeds
SSR and hydration. The existing local clock advances presentation without network
requests; memoisation avoids repeating selection work for unchanged inputs/time.
No economic model is re-resolved here. Offline timezone mismatches fail closed.

Only serializable, non-secret source data should cross the server/client boundary.
This is an optional card interface, not source configuration or persistence. It
changes no configured validity, including the existing 1 October 2026 cutoff,
and grants no Tesla mutation authority.

Tests exercise real Stage 1/2A/2B outputs and server-rendered markup, with controlled
React selection/clock hooks. They cover explicit switching/return, unavailable
and removed sources, invalid projected claims, gaps, unknown export, conditional
provenance and unchanged configured behaviour. They make no live calls.
