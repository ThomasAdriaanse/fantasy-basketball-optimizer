# Auction cash pacing plan

Branch: `auction-cash-pacing` (from `auction-auto-draft`)
Status: agreed with Thomas 2026-10-09. Step 1 (simulation script) written; baseline run pending.

## 1. Problem

In simulated auctions some teams finish with a large amount of unspent cash, which is worth nothing
after the auction. The pattern:

1. Teams that land a strong player early see clear edges and win the bids that suit their team.
2. Other teams see no player as a particular edge, so they are never the highest bidder and win almost
   nothing for a long stretch.
3. Late in the auction they start bidding, but no remaining player is worth enough to them to use up
   their cash.

This affects both autodrafters and the "Your $" recommendation shown to the user, since autodraft bids
up to exactly "Your $".

### Causes in the code

**A. "Your $" is priced on the league's money, not the team's.** In `_build_candidates`
(`backend/services/ranking.py`), "Your $" is `auction_value_adjuster` (SAVOR) on the team's H-scores,
scaled so the top `n_remaining` available players sum to the league's total remaining cash. A team
holding far more cash than it can use gets the same dollar scale as everyone else, so its values never
reach its own budget.

**B. The model credits cash a team cannot spend.** In `HAgent.get_diff_distributions` (auction branch,
`backend/math/algorithm_agents.py`), each opponent column adds `money_diff * category_value_per_dollar`
(`get_diff_means_auction`): every dollar counts as future stats at one league-wide rate, without limit.
A cash-rich team therefore looks ahead of the field, which flattens its H-scores, so no player stands out
to it as a real edge.

## 2. Design

Two changes, made and measured in this order.

### Change 1: "Your $" adds the share of cash the team cannot otherwise use

For team `t` pricing candidate `X`:

1. **Spending cap.** `s` = the open active slots `t` would have left after buying `X`. The cap is the sum
   of `t`'s own "Your $" (today's value) for its `s` best other remaining players. It estimates the most
   `t` could usefully spend after `X`, valuing each player as `t`'s next purchase.
2. **Surplus.** `max(0, C_t - cap)`, where `C_t` is `t`'s cash: money `t` cannot put to good use even
   buying its best options.
3. **Share.** `X`'s share of the surplus is in proportion to his value among those options:
   `value(X) / (value(X) + cap)`. With similar players this is close to an even split over the slots; a
   star gets more than a filler player; on the last open slot (`s = 0`, cap 0) the share is the whole
   surplus, so nothing is left over at the end.
4. **New "Your $"** = today's "Your $" + `X`'s share of the surplus, never above `t`'s maximum
   allowable bid.

Worked example (made-up numbers): Team A has $120 and 6 open slots. After buying X it has 5; its 5 best
other players are worth $25 + $22 + $20 + $18 + $15 = $100 to it, so the surplus is $20. X is worth $22
to A, so X's share is 22 / 122 of $20, about $3.60, and A's new "Your $" for X is about $25.60. Team B,
with $30 and 3 slots, has a cap of $47 for its 2 best other players, so no surplus and no change.

Properties:

- Early, every team's cap is far above its cash: no change to today's values.
- As the pool thins, a team holding more cash than its slots can use pays more, while good players are
  still available, and spends its surplus down across its remaining purchases.
- In an ascending auction the winner pays $1 over the runner-up's limit, not its own limit, so a higher
  "Your $" raises how far a team will go rather than what it pays.
- No extra evaluates: it uses the "Your $" values the evaluate already produces.

Known approximation: each "Your $" values a player as the team's next purchase (current roster plus
him), so the sum in the cap does not account for players overlapping or complementing each other once
several are bought. The simulation shows whether the cap is far enough off to matter; if it is, the
follow-up is to value the other players under the category weights the optimiser chose for `X`.

Placement: a new `backend/services/auction_pricing.py`, called from `_build_candidates`. "Gnrc. $" and
"Orig. $" are unchanged.

### Change 2: the model stops crediting cash a team cannot spend

In the money term, a team's cash counts at the league rate only up to its spending cap (as in Change 1,
over its open slots); cash beyond the cap counts as nothing. A team with less cash than its cap is
unaffected. The term stays antisymmetric, so the end-of-auction 50% check still holds.

Effect: a cash-rich team no longer looks ahead of the field because of money it cannot use, so the
players that would really help it stand out again. This targets the early passivity; Change 1 targets
the leftover cash.

Adopted only if the simulation shows it improves on Change 1 alone.

## 3. Validation: `testing_files/simulate_auction_cash.py`

Runs complete auctions with every team on autodraft, calling `nominate_auction_player` for each
nomination. Its bidding loop and nomination rotation mirror the browser's (`advanceAutobidders`,
`advanceNominatorIndex`); the script says so in its header and they must change together.

Each run writes, under `testing_files/auction_cash_runs/` (gitignored):

- `summary.json`: unspent cash per team, max / median / total, each finished team's H-score against the
  field and the field average (expected 50), settings, commit, timings;
- `spend_curve.csv`: cumulative spend per team after every nomination, to see when teams spend;
- `nominations.csv`: nominator, player, winner, price, winner's and runner-up's valuations, time taken.

It needs the app's database, so it runs on Thomas's machine with the project's environment:

    .venv\Scripts\python testing_files\simulate_auction_cash.py --label baseline

A full 12-team, 13-pick auction is 156 nominations with up to 12 evaluates each, so a run takes a
while; `--max-nominations 5` checks that it runs.

## 4. Order of work

1. Simulation script; baseline run on the current code.
2. Change 1; run.
3. Change 2; run. Keep it only if it improves on step 2.
4. Set the unspent-cash target from these runs (for example, no team ends with more than $10 unspent),
   update `docs/auctions.md`, and regenerate the auction goldens with `REGEN_GOLDENS=1` (with go-ahead).
5. Only if the cap proves too far off: value the cap's players under `X`'s chosen weights.
