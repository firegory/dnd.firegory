# Bestiary contracts

Bestiary reads use active `nfs_index_entries` as their only content input. The list, filtered count, source-version aggregation, and detail query apply the same source RBAC predicate before selecting the highest-priority accessible source version. Inaccessible rows cannot affect results, counts, facets, cursors, or direct detail routes.

Challenge rating is canonicalized as an exact numerator/denominator pair. SQL compares the numeric quotient and keyset pagination orders by `(CR, normalized title, entry ID)`; cursors never use display text ordering.

Creature prose is represented by controlled `{name, text}` blocks for traits, actions, bonus actions, reactions, and legendary actions. Collector HTML is discarded. Field citations and source versions remain attached to immutable collector/PDF evidence through review and NFS projection.

## Query budgets

- List/filter page: two database statements, one bounded keyset page plus one filtered count; default 24 and maximum 100 rows.
- Detail: one database statement, including accessible source versions and citations from the selected canonical payload.
- No offset pagination, per-row source query, or filesystem read is permitted on request paths.

The dedicated print rules hide navigation, filters, source-version chrome, and citation controls while preserving every stat-block fact and controlled combat section.
