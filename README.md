# doimus-bold

Doimus native plugin for Bold Smart Locks. A Bold Connect hub is required.

## Features

- Lock/unlock control via remote activation
- Auto-relock after device's activation timeout
- Bold Connect hub shown as switch (or lock via config)
- Automatic access token refresh
- Polls device list every 24h

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accessToken` | string | — | Bold API access token |
| `refreshToken` | string | — | Bold API refresh token |
| `refreshURL` | string | *built-in* | Custom refresh URL (for custom auth backend) |
| `legacyAuthentication` | boolean | `false` | Use legacy OAuth authentication |
| `showControllerAsLock` | boolean | `false` | Show Bold Connect hub as lock instead of switch |

## Device Capabilities

Locks expose:
| Capability | Description |
|------------|-------------|
| `locked` | `true` = locked, `false` = unlocking |
| `active` | `true` while lock is activated/unlocked |

Bold Connect hubs expose:
| Capability | Description |
|------------|-------------|
| `on` | `true` when activated |

## Official Bold API

This plugin integrates with the Bold Smart Lock platform API. For reference when extending or debugging this plugin, see the official documentation:

- [Bold Integration Guide](https://sesamsolutions.gitlab.io/public-documentation/integration/)
- [Bold API Reference](https://apidoc.boldsmartlock.com)

Key endpoints used by this plugin:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/effective-device-permissions` | GET | List accessible devices |
| `/v1/devices/{id}/remote-activation` | POST | Unlock/activate a lock |
| `/v2/oauth/token` | POST | OAuth token refresh (legacy flow) |

Authentication requirements per the official docs:

- Remote activation requires a `user`-level session with the `activate` scope
- Tokens should be refreshed before expiration; always handle `401` responses
- Organization-level sessions can use API keys (Basic Auth) but cannot activate locks directly

## Credits

This plugin is a port of [homebridge-bold](https://github.com/StefanNienhuis/homebridge-bold) by [Stefan Nienhuis](https://github.com/StefanNienhuis). Thanks to Erik Nienhuis for reverse-engineering the Bold API.

## License

MIT
