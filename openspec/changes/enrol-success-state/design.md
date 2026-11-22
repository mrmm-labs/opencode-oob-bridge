## Decisions

- **Face ID needs no second call.** The device is stored in the Keychain item before the reply, so nothing is half-finished after the first response. Only a passkey has begin and done.
- **Enrolled-devices status is the confirmation card** with the new device id. The Mini App has no list of devices (the TUI shows that), so the card shows what this enrolment made.
- **Guard in the controller as well as the view,** so a double tap before a redraw cannot spend the code twice.
