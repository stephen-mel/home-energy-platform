# Financial dashboard Stage 1

The first financial overview uses HEP's existing whole-home price signal. Verified
Kraken import rates, qualifying SMART overrides and the independently verified
export rate therefore retain their existing boundaries and provenance.

The calculation accepts bounded interval import/export energy readings. It does
not turn instantaneous Home Assistant power into energy. Readings crossing a
price boundary cannot be apportioned safely and are excluded unless every
covering window has the same known price. Planned conditional SMART rates produce
an estimate; qualified or billed eligibility plus measured energy produces a
calculated value. Partial coverage is labelled and never presented as a complete
period total.

HEP does not currently ingest historical interval meter energy, so the production
card reports zero coverage and unavailable totals while displaying the verified
rates available for the selected 24-hour period. Solar savings, battery savings
and investment payback remain explicit null future fields.
