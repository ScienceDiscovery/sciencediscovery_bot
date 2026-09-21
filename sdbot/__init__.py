"""sciencediscovery_bot: local webhook receiver for the sciencediscovery repositories.

Pipeline: HTTP (server.py) -> signature check (signature.py) -> provider adapter
(adapters/) -> unified Event (events.py) -> Router (router.py) -> hooks (hooks.py),
with every delivery appended to the event log (store.py).
"""

__version__ = "0.1.0"
