# Side apps

This folder holds **web apps** developed for OmniGate's application sandbox. Each
app is a directory of static web code (HTML/CSS/JS — no server-side code) that
gets zipped and uploaded to the gateway, which serves it on its own segregated
port behind a per-app login.

```
apps/
  xplore/        demo file browser (browse, view/edit, create file/folder, delete)
  xplore.zip     built bundle, ready to upload
```

## How an app talks to the gateway

An uploaded app runs on its **own origin** (e.g. `http://127.0.0.1:9000`) behind
the per-app **gateway**, which:

- **gates** the static files behind a login — hitting the app port without a
  valid session shows a sign-in page;
- **brokers** a user-level file API on the app's *own* origin, so the app calls
  plain relative URLs (`fetch('/api/files?path=…')`) with no token and no CORS;
- forces every app session to the **User** role — an app can never act as admin,
  even if an admin signs in to it.

Endpoints available to an app (all same-origin, user-level):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/roots` | List the allowed directory roots |
| `GET` | `/api/files?path=` | List a directory |
| `GET` | `/api/files/read?path=` | Read a file |
| `PUT` | `/api/files/write?path=` | Write/create a file (raw body) |
| `POST` | `/api/files/mkdir?path=` | Create a folder |
| `DELETE` | `/api/files/delete?path=` | Delete a file or folder (recursive) |
| `POST` | `/__logout` | End the app session |

All file paths must fall inside a configured `--allow-dir`; anything outside is
rejected by the jail.

## Building a bundle

Zip the **contents** of the app directory so `index.html` sits at the zip root.

PowerShell:

```powershell
Compress-Archive -Path apps\xplore\* -DestinationPath apps\xplore.zip -Force
```

POSIX:

```sh
( cd apps/xplore && zip -r ../xplore.zip . )
```

## Uploading

From the admin dashboard's **Apps** panel, or via the API (admin token):

```sh
curl -s -X POST http://localhost:8080/api/apps \
  -H "Authorization: Bearer $TOKEN" \
  -F name=xplore -F bundle=@apps/xplore.zip
# -> {"id":"xplore","port":9000,...}
```

Then open the reported port (e.g. <http://127.0.0.1:9000>), sign in, and use it.
