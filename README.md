# stickynotes

Simple self-hosted sticky notes / scratchpad web app.

- Single user
- File-based storage (`/opt/stickynotes/notes`)
- Autosave-first
- LAN/VPN only

## Host setup

1) Bootstrap runtime folders:

```bash
sudo ./scripts/bootstrap.sh
```

2) Create `/opt/stickynotes/config/compose.env` (optional; defaults are fine):

```bash
sudo nano /opt/stickynotes/config/compose.env
```

Example:

```env
BIND_ADDR=0.0.0.0
HOST_PORT=8060
```

3) Deploy a release zip:

```bash
sudo ./scripts/deploy.sh /tmp/stickynotes-0.2.3.zip
```

Open:

- UI: `http://<host-ip>:8060/`
- Health: `http://<host-ip>:8060/health`


## Notes
If scripts are not executable after unzip on your host:

```bash
chmod +x scripts/*.sh
```


## UI options
- Tabs order can be switched between fixed order and MRU (Most Recently Used) via the "Tabs" button.
- Sidebar can be toggled on/off via the "Sidebar" button.
