#!/usr/bin/env python3
"""Compatibility facade for the webnovel memory modules.

New code should import the owning seam directly. Existing CLIs keep importing
this module so their public interface and output remain backward compatible.
"""

from memory_diagnostics import *  # noqa: F401,F403
from memory_index import *  # noqa: F401,F403
from memory_patch_schema import *  # noqa: F401,F403
from memory_paths import *  # noqa: F401,F403
from memory_transactions import *  # noqa: F401,F403

# Preserve historically importable private helpers used by internal tests and
# maintenance scripts while ownership lives in the seam modules above.
from memory_diagnostics import _extract_entities, _extract_tags  # noqa: F401
from memory_index import _ensure_index_unlocked, _rebuild_index_unlocked, _record_is_valid  # noqa: F401
from memory_patch_schema import _revision_source_paths, _validate_metadata, _validate_revision_map  # noqa: F401
from memory_transactions import _apply_transaction_unlocked, _recover_transactions_unlocked  # noqa: F401
