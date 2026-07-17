import unittest
from datetime import date

from scripts.ml.binance_archive import (
    archive_months,
    funding_archive_url,
    kline_archive_url,
    parse_funding_csv,
    parse_kline_csv,
)


class ArchivePlanningTests(unittest.TestCase):
    def test_month_plan_includes_boundary_months_for_later_trimming(self):
        self.assertEqual(
            archive_months(date(2026, 1, 14), date(2026, 6, 30)),
            ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
        )

    def test_urls_target_usdm_futures_archives(self):
        self.assertEqual(
            kline_archive_url("BTCUSDT", "15m", "2026-06"),
            "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/15m/BTCUSDT-15m-2026-06.zip",
        )
        self.assertEqual(
            funding_archive_url("BTCUSDT", "2026-06"),
            "https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2026-06.zip",
        )


class ArchiveParsingTests(unittest.TestCase):
    def test_parses_headered_futures_klines_and_trims_to_range(self):
        csv_text = "\n".join(
            [
                "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore",
                "1000,10,12,9,11,50,1999,0,0,0,0,0",
                "2000,11,13,10,12,60,2999,0,0,0,0,0",
            ]
        )
        rows = parse_kline_csv(csv_text, start_ms=1500, end_ms=2500)
        self.assertEqual(rows, [{"timestamp": 2000, "open": 11.0, "high": 13.0, "low": 10.0, "close": 12.0, "volume": 60.0}])

    def test_parses_funding_rate_schema(self):
        csv_text = "calc_time,funding_interval_hours,last_funding_rate\n1001,8,0.0001\n"
        self.assertEqual(
            parse_funding_csv(csv_text, start_ms=1000, end_ms=2000),
            [{"timestamp": 1001, "intervalHours": 8, "rate": 0.0001}],
        )


if __name__ == "__main__":
    unittest.main()
