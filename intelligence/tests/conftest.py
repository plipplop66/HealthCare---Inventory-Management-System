"""Shared pytest setup.

The ordinary suite must never need Docker or a MySQL server, so it always runs on the offline
fixture, whatever DATA_SOURCE the shell sets. tests/test_mysql_live.py opts into MySQL explicitly.
"""

import os

os.environ["DATA_SOURCE"] = "fixture"
