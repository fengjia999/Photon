# Photon Bridge

A transport-only Photon Spectrum bridge for AI Memory Gateway. It does not run
an agent or a model.

Inbound text DMs from the configured iMessage handles are forwarded to the
gateway's streaming OpenAI-compatible chat route. Public `reasoning_content`
is sent first as separate `（...）` bubbles; opaque `reasoning_details` needed
for tool continuation are never displayed. Final assistant output is split on
commas, periods, and newlines, with punctuation kept in the preceding bubble.
`POST /notify` sends proactive heartbeat notifications to `PHOTON_HOME_USER`
using the same bubble rule. Inbound Tapbacks are forwarded with their emoji
and a short summary of the message that was reacted to.

The bridge also advertises conversation-local frontend tools to the gateway.
The model may add a native Tapback to the current inbound message or send its
answer as threaded iMessage bubbles with an optional native effect. These
actions execute inside the bridge so message and chat identifiers never need
to be exposed as model arguments. If no native reply tool is used, the final
model text is sent as ordinary bubbles as before.

## Environment

```env
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
PHOTON_HOME_USER=+8613812345678
PHOTON_ALLOWED_USERS=+8613812345678,+14155552671
MEMORY_GATEWAY_URL=https://your-memory-gateway.example
MEMORY_GATEWAY_SECRET=...
BRIDGE_SECRET=use-a-different-strong-secret
PORT=8080
MAX_BUBBLE_CHARACTERS=3000
BUBBLE_DELAY_MS=1000
MAX_IMAGE_BYTES=5242880
```

`PHOTON_HOME_USER` chooses the E.164 phone number used for proactive sends.
`PHOTON_ALLOWED_USERS` controls which E.164 phone numbers may send inbound
prompts. Replies stay in the conversation that sent the prompt.

Outgoing bubbles in the same conversation are paced at least one second apart.
Increase `BUBBLE_DELAY_MS` to use a slower rhythm; values below 1000 are clamped.

Inbound JPEG, PNG, GIF, and WebP images are forwarded as vision input. iPhone
HEIC/HEIF photos are converted to JPEG automatically. Captions and up to four
images sent in one iMessage stay together in one gateway turn.

Set the gateway's `PHOTON_NOTIFY_URL` to this service's `/notify` URL and
`PHOTON_NOTIFY_SECRET` to `BRIDGE_SECRET`. The bridge explicitly requests a
stream, independent of the gateway's `FORCE_STREAM` default. Because tool
lists are frozen per conversation, switch to a newly created conversation
after the gateway and bridge restart before expecting the iMessage tools to
appear.

## Zeabur

Deploy this repository as a separate service. No custom root directory is
needed. The included Dockerfile builds and starts the service. `/health` is an
unauthenticated health check; `/notify` requires the bridge bearer token.
