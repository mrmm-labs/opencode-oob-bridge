## 1. Shared enrolment

- [x] 1.1 Keep the open enrolment in the data directory, hashed, and spend or count it there. Verify: `service.test.ts`.
- [x] 1.2 Log `enrol_opened` and `enrol_result`. Verify: `service.test.ts`.
- [x] 1.3 No token stored on a refusal; a retry overwrites. Verify: `miniapp/controller.test.js`.
