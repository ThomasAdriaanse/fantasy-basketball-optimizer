"""
Auction pricing rules for the H-score table's "Your $".

compute_max_allowed_bid: the most a team may bid while keeping $1 for every other empty slot.

add_unusable_cash_shares: "Your $" alone is priced on the league's money, so a team holding more cash than
its open slots can use never bids it and ends the auction with money left over. Each candidate's "Your $"
gets a share of the cash the team could not otherwise use if it bought him.
"""

from __future__ import annotations

import math

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


def add_unusable_cash_shares(
    your_dollar_series: pd.Series
    , rosterable_players: pd.Index
    , team_cash: float
    , open_active_slots: int
    , empty_roster_slots: int
) -> pd.Series:
    """Each player's "Your $" plus an even share of the cash the team could not otherwise use, capped at the
    team's maximum allowable bid.

      - the team's best options: its top rosterable players by "Your $", one per open active slot. They are
        the players it would fill its slots with;
      - surplus: the team's cash, minus what those players cost (each at no less than the $1 minimum bid),
        minus $1 for each empty bench slot;
      - each of those players gets surplus / (number of them) added; everyone else is unchanged.

    Example: $60, two open active slots, players worth $20, $10 and $5. The best options cost $30, so the
    surplus is $30 and the first two become $35 and $25, which together spend the team's cash. A team whose
    best options already cost all its cash has no surplus and nothing changes.

    your_dollar_series covers the available pool; rosterable_players are those whose positions fit one of
    the team's open active slots (the candidates the table shows)."""
    if open_active_slots < 1:
        raise ValueError(f'Pricing needs an open active slot; the team has {open_active_slots}.')
    if empty_roster_slots < open_active_slots:
        raise ValueError(f'The team has {empty_roster_slots} empty roster slots but {open_active_slots} open '
                         f'active slots; active slots are part of the roster.')

    bench_reserve = empty_roster_slots - open_active_slots
    best_options  = your_dollar_series.loc[rosterable_players].sort_values(ascending=False).iloc[:open_active_slots]
    surplus       = max(0.0, team_cash - best_options.clip(lower=1.0).sum() - bench_reserve)

    adjusted = your_dollar_series.copy()
    if len(best_options) > 0:
        adjusted.loc[best_options.index] += surplus / len(best_options)
    return adjusted.clip(upper=compute_max_allowed_bid(team_cash, empty_roster_slots))
