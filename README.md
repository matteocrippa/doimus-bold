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

## Credits

This plugin is a port of [homebridge-bold](https://github.com/StefanNienhuis/homebridge-bold) by [Stefan Nienhuis](https://github.com/StefanNienhuis). Thanks to Erik Nienhuis for reverse-engineering the Bold API.

## License

MIT
