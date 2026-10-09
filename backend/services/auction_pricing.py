"""
Auction pricing rules shared by the H-score table and the auction autodraft.

compute_max_allowed_bids: the most each team may bid while keeping $1 for every other empty slot.

add_unusable_cash_shares: auction_cash_pacing_plan.md, Change 1. "Your $" alone is priced on the league's
money, so a team holding more cash than its open slots can use never bids it and ends the auction with
money left over. Each candidate's "Your $" gets a share of the cash the team could not otherwise use if it
bought him.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd


def compute_max_allowed_bid(
    remaining_cash: float
    , empty_slots: int
) -> int:
    """The most a team may bid while keeping $1 for every other empty roster slot (bench included).
    A team with no empty slot cannot bid at all."""
    if empty_slots <= 0:
        return 0
    return max(0, math.floor(remaining_cash - (empty_slots - 1)))


def compute_max_allowed_bids(
    player_assignments: dict[str, list[int]]
    , remaining_cash: dict[str, float]
    , total_roster_picks: int
) -> dict[str, int]:
    return {team: compute_max_allowed_bid(remaining_cash[team], total_roster_picks - len(roster))
            for team, roster in player_assignments.items()}


def add_unusable_cash_shares(
    your_dollar_series: pd.Series
    , rosterable_players: pd.Index
    , team_cash: float
    , open_active_slots: int
    , empty_roster_slots: int
) -> pd.Series:
    """Each player's "Your $" plus his share of the cash the team could not otherwise use, capped at the
    team's maximum allowable bid.

    For a candidate X:
      - spending cap: the team's own "Your $" for its best other rosterable players, one per active slot it
        would still have open after buying X (each counted at no less than the $1 minimum bid). It is the
        most the team could usefully spend after X, valuing each player as its next purchase;
      - surplus: cash beyond that cap and beyond $1 for each empty bench slot left after X;
      - share: value(X) / (value(X) + cap), so a star takes more of the surplus than a filler player, and on
        the last open active slot (cap 0) the share is the whole surplus;
      - only a player among the team's best options, one per open active slot, takes a share: those are the
        players it would fill its slots with. Without this, on the last slot every player would carry the
        whole surplus and the team would spend it on whoever happened to be nominated first.

    your_dollar_series covers the available pool; rosterable_players are those whose positions fit one of
    the team's open active slots (the candidates the table shows)."""
    if open_active_slots < 1:
        raise ValueError(f'Pricing needs an open active slot; the team has {open_active_slots}.')
    if empty_roster_slots < open_active_slots:
        raise ValueError(f'The team has {empty_roster_slots} empty roster slots but {open_active_slots} open '
                         f'active slots; active slots are part of the roster.')

    slots_after_purchase = open_active_slots - 1
    bench_reserve        = empty_roster_slots - 1 - slots_after_purchase
    values               = your_dollar_series.clip(lower=0.0)

    slot_costs        = values.loc[rosterable_players].clip(lower=1.0).sort_values(ascending=False)
    best_costs        = slot_costs.iloc[:slots_after_purchase + 1]
    cap_without_swap  = best_costs.iloc[:slots_after_purchase].sum()
    # A candidate who is himself among the best `slots_after_purchase` is replaced in his own cap by the
    # next-best player.
    in_best = values.index.isin(best_costs.index[:slots_after_purchase])
    caps = pd.Series(cap_without_swap, index=values.index)
    caps[in_best] = best_costs.sum() - slot_costs.loc[values.index[in_best]].to_numpy()

    surplus = (team_cash - bench_reserve - caps).clip(lower=0.0)
    takes_share = values.index.isin(slot_costs.index[:open_active_slots]) & (values > 0).to_numpy()
    shares  = pd.Series(np.where(takes_share, values / (values + caps).where(takes_share, 1.0), 0.0),
                        index=values.index)
    adjusted = your_dollar_series + shares * surplus
    return adjusted.clip(upper=compute_max_allowed_bid(team_cash, empty_roster_slots))
