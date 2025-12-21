from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pandas as pd
import nflreadpy as nfl


@dataclass(frozen=True)
class PbpFilters:
    week_start: Optional[int] = None
    week_end: Optional[int] = None
    min_wp: Optional[float] = None
    max_wp: Optional[float] = None
    include_playoffs: bool = False


REQUIRED_BASE_COLS = {"epa", "posteam", "defteam"}
def load_pbp_pandas(season: int) -> pd.DataFrame:
    """
    Load play-by-play data for a given season using nflreadpy.

    nflreadpy returns a Polars DataFrame; we immediately convert to pandas so the
    rest of the pipeline stays simple.

    Raises:
        ValueError: if the expected columns are missing.
    """
    pbp_polars = nfl.load_pbp(seasons=season)
    pbp = pbp_polars.to_pandas()

    missing = REQUIRED_BASE_COLS - set(pbp.columns)
    if missing:
        raise ValueError(f"PBP missing required columns: {sorted(missing)}")

    return pbp


def apply_filters(pbp: pd.DataFrame, f: PbpFilters) -> pd.DataFrame:
    """
    Filter by season_type (REG unless include_playoffs), week range, and wp range.
    We fail fast if user requested a filter but the column doesn't exist.
    """
    df = pbp.copy()

    # Validate ranges early
    if f.week_start is not None and f.week_end is not None and f.week_start > f.week_end:
        raise ValueError(f"--week-start ({f.week_start}) cannot be > --week-end ({f.week_end})")

    if f.min_wp is not None and not (0.0 <= f.min_wp <= 1.0):
        raise ValueError(f"--min-wp must be between 0 and 1. Got {f.min_wp}")
    if f.max_wp is not None and not (0.0 <= f.max_wp <= 1.0):
        raise ValueError(f"--max-wp must be between 0 and 1. Got {f.max_wp}")
    if f.min_wp is not None and f.max_wp is not None and f.min_wp > f.max_wp:
        raise ValueError(f"--min-wp ({f.min_wp}) cannot be > --max-wp ({f.max_wp})")

    # Season type filter
    if not f.include_playoffs:
        if "season_type" in df.columns:
            df = df[df["season_type"].astype(str).str.upper() == "REG"]

    # Week filters
    if f.week_start is not None or f.week_end is not None:
        if "week" not in df.columns:
            raise ValueError("PBP missing 'week' column but week filtering was requested.")
        df["week"] = pd.to_numeric(df["week"], errors="coerce")
        if f.week_start is not None:
            df = df[df["week"] >= f.week_start]
        if f.week_end is not None:
            df = df[df["week"] <= f.week_end]

    # Win prob filters
    if f.min_wp is not None or f.max_wp is not None:
        if "wp" not in df.columns:
            raise ValueError("PBP missing 'wp' column but win-probability filtering was requested.")
        df["wp"] = pd.to_numeric(df["wp"], errors="coerce")
        if f.min_wp is not None:
            df = df[df["wp"] >= f.min_wp]
        if f.max_wp is not None:
            df = df[df["wp"] <= f.max_wp]

    return df


def compute_team_epa(pbp: pd.DataFrame) -> pd.DataFrame:
    """
    Compute mean EPA/play for offense (posteam) and defense (defteam).
    Defensive EPA here reflects EPA allowed (same sign as offensive EPA); if
    you prefer "better defense = higher" flip the sign in downstream visuals.
    Output columns:
        team, EPA_off_per_play, EPA_def_per_play
    """
    df = pbp.copy()
    df["epa"] = pd.to_numeric(df["epa"], errors="coerce")

    off = (
        df.dropna(subset=["epa", "posteam"])
          .groupby("posteam")["epa"]
          .mean()
          .rename("EPA_off_per_play")
          .reset_index()
          .rename(columns={"posteam": "team"})
    )

    deff = (
        df.dropna(subset=["epa", "defteam"])
          .groupby("defteam")["epa"]
          .mean()
          .rename("EPA_def_per_play")
          .reset_index()
          .rename(columns={"defteam": "team"})
    )

    merged = pd.merge(off, deff, on="team", how="outer")
    merged["team"] = merged["team"].astype(str).str.strip().str.upper()

    merged = merged[["team", "EPA_off_per_play", "EPA_def_per_play"]].sort_values("team").reset_index(drop=True)

    required_out = {"team", "EPA_off_per_play", "EPA_def_per_play"}
    missing_out = required_out - set(merged.columns)
    if missing_out:
        raise ValueError(f"Output missing columns: {sorted(missing_out)}")

    return merged


def build_team_epa(season: int, filters: Optional[PbpFilters] = None) -> pd.DataFrame:
    """
    One-call helper:
    - load pbp for season
    - apply filters
    - compute team EPA
    """
    f = filters or PbpFilters()
    pbp = load_pbp_pandas(season)
    pbp = apply_filters(pbp, f)
    return compute_team_epa(pbp)
