# Auction cash pacing plan

Branch: `auction-cash-pacing` (from `auction-auto-draft`)
Status: plan, awaiting decisions on the open questions in section 7. No code changed yet.

## 1. Problem

In simulated auctions some teams finish with a large amount of unspent cash. The pattern:

1. Teams that land a strong player early commit to a build (a punt) and win the bids that fit it.
2. Teams that do not commit see no player as a particular edge, so they are never the highest bidder and
   win almost nothing for a long stretch.
3. Late in the auction they start bidding, but no remaining player is worth enough to them to use up
   their cash. They end with money left over, which is worth nothing after the auction.

This affects both the autodrafters and the "Your $" recommendation shown to the user, since autodraft
bids up to exactly "Your $".

### Causes in the code

**A. The model believes unspent cash will always buy stats.** In
`HAgent.get_diff_distributions` (auction branch, `backend/math/algorithm_agents.py`), each opponent
column gets `money_diff * category_value_per_dollar` added to the score differential
(`get_diff_means_auction`). `value_per_dollar` is one league-wide rate (value left in the pool over cash
left in the league) and the stats it buys are spread over the categories by the fixed `v` direction.
So:

- the rate never runs out: a team with $150 to the field's $50 is credited with $100 of future stats,
  however few slots it has and however thin the pool is;
- the stats are generic: cash is assumed to buy whatever the average player brings, not players that
  fit the team's build.

A cash-rich team therefore looks comfortably ahead in the model and feels no pressure to buy.

**B. "Your $" is priced on the league's money, not the team's.** In `_build_candidates`
(`backend/services/ranking.py`) "Your $" is `auction_value_adjuster` (SAVOR) on the team's H-scores,
scaled so the top `n_remaining` available players sum to the league's total remaining cash. A team
holding three times the average cash gets the same dollar scale as everyone else, so late in the auction
its values cannot reach its own budget.

## 2. Goals

- A team's valuation of cash reflects what that cash can still buy **efficiently for its build**: players
  that fit its build, limited by its open slots and by what is left in the pool. Buying the five best
  remaining players is not efficient if they do not fit one build together; the model must see that the
  cash would have been better spent earlier on a player that fits.
- "Your $" becomes the team's own willingness to pay, so a team whose cash is losing value bids it, and a
  team that is short of cash bids less.
- Autodraft and the "Your $" column stay identical (autodraft bids up to "Your $").
- Everything comes out of the model; no spend-down rules or fixed pacing heuristics.

### Success criteria (to confirm, see Q5)

Measured by the simulation script (section 5) over full all-autodrafter auctions:

- unspent cash at the end, per team: reported as max, median and total; target to be agreed;
- the spend curve: cumulative spend per team by nomination number, so late hoarding is visible;
- the end-of-auction check still holds: with every roster full the field's win rates average 50%;
- no team ends with an illegal roster or a failed pick.

## 3. Decisions so far

| Decision | Choice |
|---|---|
| Approach | Layer 1 option 1b (build-aware usable cash) + Layer 2 option 2c (team-specific price from the marginal value of a dollar); 2d (exact reservation price) kept as the upgrade if 2c proves off. Confirm. |
| Display | "Your $" itself changes to the team-specific willingness to pay; no new column. "Gnrc. $" and "Orig. $" are unchanged. |
| Upstream | Change the model in place; diverging from zer2's upstream is accepted. |
| Validation | Add a backend simulation script; run it only with Thomas's go-ahead. |

## 4. Design

### 4.1 Layer 1: build-aware usable cash

Replace the linear money term with the stats each team's cash can **efficiently** buy.

For a team `t` with cash `C_t` and `s_t` open active slots, over the available pool:

- `x_i` is player `i`'s stat vector, measured above replacement (`x_i - x_rep`, clipped at zero in
  value terms as SAVOR does).
- `b_t,i` is how much player `i` is worth **to team t's build**: `x_i` weighted by `t`'s category
  weights (see Q1 for which weights).
- `pi_i` is player `i`'s expected market price: his "Gnrc. $" (see Q2).

The **efficient bundle** for `t` is the set of at most `s_t` players that maximises total build value
`sum b_t,i` subject to `sum pi_i <= C_t`. The team's **usable cash stats** `M_t` are the summed stat
vectors `sum (x_i - x_rep)` of that bundle.

The money term becomes `M_drafter - M_opponent` in place of `(C_drafter - C_opponent) * value_per_dollar`.

Properties:

- **Early in the auction** cash buys build-fitting players freely, so `M_t` grows with cash much as
  today, and early valuations should change little.
- **Late in the auction** `M_t` saturates: past the price of the best build-fitting bundle that fits in the
  open slots, extra cash adds nothing. A cash-rich team is no longer credited with stats it cannot buy.
- **Build fit is built in.** Players that do not fit the build have low `b_t,i` and rarely enter the
  bundle, so a team whose build has thin remaining support gets a small `M_t`. That lowers its baseline
  win chance and raises the marginal value of a fitting player available **now**, which is the pressure
  to spend earlier that the current model lacks.
- **Zero-sum and the 50% check are preserved.** The term stays antisymmetric (`M_a - M_b` against
  `M_b - M_a`), and at the end of the auction every `s_t = 0`, so `M_t = 0`.

Solving the bundle: two constraints (slots and cash) over a few hundred players. The linear-programming
relaxation is solvable exactly and cheaply, and gives `M_t` as a concave, piecewise-linear function of
`C_t` with a known derivative `dM_t / dC_t` (the stats bought by the marginal dollar), which Layer 2
needs. Whether to use the relaxation or the integer bundle is part of Q1's cost question; the relaxation
is the default.

Interactions to resolve in the implementation:

- **Replacement term.** `player_diff * replacement_value` already fills every open slot at replacement
  level. The bundle is measured above replacement, so the two add without double counting.
- **Future-pick tilt.** The optimiser adds `(n_picks - 1 - n_selected) * expected_pick_tilts(weights)`, the
  draft's truncated-max model of build-tilted future picks, in auctions as well. In an auction the
  bundle now models what future purchases bring for the build, so keeping both would count build tilt
  twice for the slots the bundle covers. See Q3.
- **Opponents.** Each opponent's `M` needs a build too. The opponent model already stores each seat's
  predicted build (`_team_states`, `mu_edge`, committed diffs); empty seats use their predicted anchor's
  build. Seats without a modelled build use the neutral weights `v`.

Placement: the bundle solver goes in a new module, `backend/math/auction_cash_value.py`, called from
`get_diff_distributions`; `algorithm_agents.py` is already over 3,400 lines.

### 4.2 Layer 2: "Your $" from the marginal value of a dollar

For team `t` and candidate `i`, the most `t` should pay is the price at which buying `i` leaves it exactly
as well off as not buying him:

- `dH_t,i` = `H_t(i)` minus `H_t(no purchase)`: the H-score gain from `i`. The "no purchase" baseline is
  the slot left open and the cash kept, which is what the replacement player's row represents (he costs
  $1 and brings replacement value). Both rows come out of the same evaluate.
- `dH_t / dC` = how much one more dollar raises `t`'s objective. With Layer 1 this is analytic:
  `sum over categories of (dObjective / dDiff_c) * (dM_t,c / dC_t)`, where `dObjective / dDiff_c` is the
  pdf weight the optimiser already computes, and `dM / dC` comes from the bundle solution. No extra
  evaluate is needed. A finite difference (one extra evaluate at cash `C_t + delta`) is the check on the
  analytic form during development.

"Your $" for `i` = `dH_t,i / (dH_t / dC)`, floored at $0 and, for display, capped at the team's maximum
allowable bid.

What this does:

- A team whose remaining cash buys little (late, cash-rich, or thin build support) has a small `dH/dC`,
  so its prices rise towards what it can afford.
- A team short of cash has a large `dH/dC`, so its prices fall.
- Early in the auction, with `M` close to linear, prices land near today's scale.

Consequences:

- "Your $" no longer sums to the league's remaining cash. It is a willingness to pay, not a market price.
  "Gnrc. $" stays as the market reference.
- Whether SAVOR's streaming-noise adjustment still applies on top is Q4.
- Placement: the conversion moves out of `_build_candidates` into a new
  `backend/services/auction_pricing.py`, which `ranking.py` calls.

**Upgrade path (2d).** If the simulation shows the linearised price is noticeably off for big-ticket
players (the price changes `C_t` enough to move `dH/dC`), solve `H_t,i(C_t - p) = H_t(no purchase)` for
`p` exactly. For autodraft this is a few evaluates on a two-row batch (the nominee and the replacement
player); for the whole "Your $" column it is several full evaluates, so it would be considered only if
2c fails.

### 4.3 Autodraft and the UI

- Autodraft needs no new logic: it already bids up to "Your $" (rounded down) within the maximum allowable
  bid.
- The nominator still nominates its top-H-score player. Nominating to drain rivals' cash is out of scope.
- `docs/auctions.md` gets a section describing the new "Your $".

## 5. Validation script

`testing_files/simulate_auction_cash.py`: runs complete auctions server-side with every team on
autodraft, calling `nominate_auction_player` for each nomination and applying the same bidding rules as
the browser (rotation, $1 round-robin raises, permanent pass, maximum allowable bid). The bidding loop is
a direct mirror of `advanceAutobidders` in `frontend/data_entry/auction_autodraft.ts`; the script says so
in its header, and both must change together.

Reports per run:

- final unspent cash per team, and max / median / total;
- cumulative spend per team by nomination number (CSV, for a chart);
- each final roster's win rate against the field, and the field average (expected 50%);
- the per-nomination runtime.

Runs: the branch before the change (baseline) and after each phase, on the default league
(12 teams, 13 picks, $200) and at least one other configuration. One auction is about 156 nominations
with up to 12 evaluates each, so expect several minutes per run.

## 6. Order of work

1. **Baseline.** Write the simulation script; with go-ahead, run it on the current code to measure the
   problem.
2. **Layer 1.** `auction_cash_value.py` (bundle solver + `dM/dC`), wired into
   `get_diff_distributions`; resolve Q3. Re-run the simulation.
3. **Layer 2.** `auction_pricing.py` (the price conversion), wired into `_build_candidates`; check the
   analytic `dH/dC` against a finite difference on a few boards. Re-run the simulation.
4. **Finish.** Docs, UI wording for "Your $", regenerate the auction goldens with `REGEN_GOLDENS=1`
   (with go-ahead), and decide whether 2d is needed.

## 7. Open questions

**Q1. Whose build values a team's future purchases?**
- (a) The optimiser's per-candidate weights: each candidate implies its own build, so the bundle is
  re-solved per candidate per iteration. Most faithful; costliest.
- (b) The team's committed build from its stored state, one bundle per team per evaluate. Cheap.
- Proposed: (b) for opponents (it is how the opponent model already works) and measure whether (a) is
  affordable for the drafter's own seat.

**Q2. Expected prices of future purchases.** Proposed: "Gnrc. $", the market value the field is paying.
Alternative: the opponents' modelled valuations, which would make prices build-aware too but cost an
evaluate per seat.

**Q3. Keep the truncated-max future-pick tilt in auctions?** Proposed: apply it only to open slots the
bundle does not cover (the ones filled near replacement for about $1), so build tilt is not counted
twice. Alternative: drop it in auction mode.

**Q4. Keep SAVOR's streaming adjustment in "Your $"?** It discounts players near replacement because
they could be streamed. Proposed: keep it, applied to the build value before the price conversion.

**Q5. Target for unspent cash.** For example: no team ends with more than $N unspent beyond its $1
fills. Proposed: set `N` after the baseline run shows how bad it is today.
