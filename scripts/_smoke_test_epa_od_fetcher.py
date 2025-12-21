"""Quick smoke test.

Run as a module so the scripts package resolves correctly:

    python -m scripts._smoke_test_epa_od_fetcher
"""

from scripts.epa_od_fetcher import build_team_epa, PbpFilters


if __name__ == "__main__":
    df = build_team_epa(2025, PbpFilters(include_playoffs=True))
    print(df.head(10))
    print("rows:", len(df))
    print("cols:", list(df.columns))
