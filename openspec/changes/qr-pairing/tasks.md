## 1. Open on what the button names

- [x] 1.1 Parse `s_`, `a_`, `enrol_` and a bare id; read the start parameter from the init data too. Verify: tests for the parse and for the launch.
- [x] 1.2 Route a session start to its detail, and a bad id to the list with a toast. Verify: controller tests.
- [x] 1.3 Send `s_<id>` in the Open button. Verify: the Telegram connector tests.

## 2. QR pairing

- [x] 2.1 Build the enrolment link and show its QR at the Mac. Verify: a test for the link; the QR is drawn by the menu only.
- [x] 2.2 The enrolment screen starts with the scanned code filled in and Face ID focused. Verify: a controller test and a screenshot.
- [x] 2.3 README. Verify: `scripts/hygiene.sh`.
