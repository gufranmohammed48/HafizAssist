# Recite Al Quran: launch and accounts plan

Prepared October 17, 2026, America/New_York; status updated in V49. The owner approved account implementation later that day. V39 introduced the account frontend, separate Cloudflare Worker/D1 backend, setup instructions, and privacy page. V40 records the owner's new D1 database configuration and confirmed Google redirect registration. V41 initializes the new D1 schema and deploys the separate account Worker. The owner has since published the matching frontend and reports successful live Google sign-in and restoration of the saved position on a second login. This is owner-reported behavior, not an independent complete account test. V43 added username/password accounts locally; V48 completes their approved backend migration, secret setup, and deployment. Live password account flows have not been tested; V49 completed isolated local checks as recorded below. Launch announcements remain drafts. See `accounts/README.md` for configuration and maintenance instructions.

## Launch after Google sign-in is added

Publish the current working version as a free public beta at **recitealquran.com**, with the original Teacher recordings and timings. QUD remains an unused experiment on `test2.html`; it is not the production audio source. Keep desktop and mobile entries on the same release. Keep offline updates safe during recitation and retain a recoverable copy of the working release.

The owner chose on October 17 to **wait until sign-in is added before launching**. The new D1 database, Google callback, remote migration, separate account Worker, credentials, and matching frontend are now connected. The owner reports that Google sign-in works and a second login resumes the saved position. No public announcements have been sent. Share launch copy only after the owner approves the copy and destination; a draft here does not authorize public messages. Broader account flows have not been independently tested. Additional tests and browser checks require a separate explicit request under the project instructions.

V42 converted both Google credential bindings from plain Worker variables to encrypted Worker secrets, preserving their working values. Cloudflare binding metadata confirms the encrypted storage type. No additional frontend publication or public announcement was made in that configuration/documentation batch; the owner had already published the OAuth frontend and reported the successful login/resume result.

V43 adds separate username/password signup, login, recovery-code reset, and password changes to the shared English/Arabic account dialog. Signup and reset show a new recovery code once and require the user to acknowledge saving it. No email-reset service is configured. The local implementation uses an additive D1 migration, salted password verifiers with a private server pepper, and persistent rate limits. Publish the account Worker after applying migration `0002_password_accounts.sql` and adding a new private `PASSWORD_PEPPER`; preserve existing Google secrets and accounts. Publish the matching frontend separately. Neither deployment nor tests were performed for this batch. The 3D-style mic and Teacher icons now match the account icon; Teacher animation remains tied to an enabled Teacher and active recitation microphone.

V48 completes the owner-approved username/password account-service deployment. Remote migration 0002 succeeded, PASSWORD_PEPPER was created privately, and Worker version 1eba00f9-be93-433b-b89c-c01a9e68f994 is active at 100% with the existing Google secrets, origin, and database preserved. The static website was not republished in this batch; local V48 badges and notes are ready for the owner. No account-flow, browser, or microphone tests were run; server bundling was part of deployment. Public announcements remain drafts.

V49 adds repeatable account tests at the owner's explicit request. All 51 completed local checks passed: 17 browser-interface cases against the actual account module with a mocked API, and 34 actual account Worker JavaScript/real in-memory SQLite contract cases. Coverage includes signup/login, password change and recovery, session revocation, progress ownership and conflicts, rate limits, offline queues, Arabic initials, and mobile forms. Native workerd and live-server attempts were blocked before case execution, so production behavior and Cloudflare CPU limits remain unverified. No live test account, product fix, push, or deployment occurred. See accounts/tests/README.md and its sanitized result artifacts.

Position the product as a Quran memorization companion with word tracking and reference audio. It offers five Teacher recitation choices across four reciters, English/Arabic interface options, and offline reading and recognition after the app and approximately 72.7 MB model have been saved successfully. Teacher audio needs a connection unless the particular reference clip is already cached; do not advertise a completely downloaded Quran audio library. Automatic tracking and Tajweed suggestions can be wrong and do not replace a qualified teacher.

Keep the launch free, without paid advertising, subscriptions, donations tied to access, or other monetization. Existing upstream code/model terms require a free, noncommercial service; those terms remain relevant even when accounts are added.

## Google accounts: implemented in V39; login and resume reported working

The earlier Desktop-HafizAssist `accounts` implementation uses a **Cloudflare Worker and D1**, Google OAuth/OIDC, same-origin `/api/account` routes, and HttpOnly session cookies. It is currently configured for one origin. Reuse its authentication approach and, if approved, its existing Google OAuth client/project; Google credentials must remain secure server-side Worker secrets. Reusing the owner's Google account means reusing the configured provider project, never sharing the owner's personal login with visitors.

- **Desktop:** a beveled account icon immediately before the version badge. Production builds hide the badge and place the account icon at the far right; local previews and test pages keep their loaded version.
- **Mobile:** a compact account icon beside the version badge at the top right, with a **Sign in** label in its menu. It must not cover Quran text, displace the five reading controls, or obscure the version badge.
- **Entry flow:** **Continue with Google** handles both new and returning Google users. V43 also prepares username sign-in, **Create account**, and recovery-code reset; Google and username accounts are separate, with no automatic merge. Guests retain the complete reading, recognition, and Teacher experience without registration.
- **Signed in:** show the account name, synchronization status, **Resume saved position**, and **Sign out**. Resume is explicit; remote changes never move a live reading pointer while the microphone is active.

The approved initial scope is **resume position and compact session totals only**: last page, surah, ayah, next-word position, update time, and correct/reviewed-word counts. Use new app-isolated records and explicit word coordinates; do not directly reuse the old app's cursor or assume its word indexing matches this app. Per-word history, charts, preference synchronization, and analytics infrastructure are outside this scope. Do not upload microphone audio, recordings, model files, or raw recognition transcripts.

Write locally first and synchronize small updates after meaningful progress, on stopping practice, and after connectivity returns. Debounce writes instead of making a network request for every word. Preserve offline guest practice; a first Google sign-in requires a connection. Before importing existing local progress into an account, ask which position to retain if the account already has a different saved position. Separate devices should not overwrite an active session silently.

The previous deployment used `hafizassist.com`. The separate Recite Al Quran account Worker/route and isolated app storage retain the old app's configuration and data. The owner registered **`https://recitealquran.com/api/account/callback`** in Google Cloud and created D1 database `recitealquran-accounts` with ID `bc19d842-ecb3-443a-b363-3a4e2b4d955b`; V40 records that ID in `accounts/wrangler.jsonc`. The remote migration and account Worker deployment are complete, and the matching frontend was published in commit `6e215fc` (`Added Google oauth`). Keep the existing Google client credentials private on the new `recitealquran-accounts` Worker. **Do not blindly replace the old Worker's `APP_ORIGIN`**, which could break Desktop-HafizAssist. Preserve ownership checks on every progress read/write, data deletion, and guest data on sign-out. The owner's successful login/resume report does not establish that every account or synchronization flow has been tested. Existing old-app cloud resources are unchanged.

## Launch messages for approval

These drafts describe the Google flow already reported live. V48 has now published the username/password backend, but those account flows have not been tested; update public launch claims after the owner confirms the new experience.

**English**

Recite Al Quran is now available as a free public beta: https://recitealquran.com

Practice memorization with a Mushaf page, follow your recitation word by word, and turn on Teacher for a reference word when you pause or a word needs review. Choose from five recitation options. Sign in with Google to save your position and continue next time, or keep practicing as a guest. English and Arabic interfaces are available. Reading and recognition can work offline after the required files are saved; Teacher audio availability depends on downloaded clips.

Try a short passage and tell us where tracking needs improvement. Automatic feedback can be wrong and is a practice aid alongside learning with a qualified teacher.

**العربية**

أطلقنا النسخة التجريبية المجانية من «Recite Al Quran»: https://recitealquran.com

راجع حفظك من صفحة المصحف، وتابع تلاوتك كلمة بكلمة. يمكنك تفعيل المعلّم لسماع الكلمة عند التوقف أو عندما تحتاج إلى المراجعة، مع خمسة خيارات للتلاوة وواجهة عربية أو إنجليزية. سجّل الدخول باستخدام Google لحفظ موضعك ومتابعة المراجعة لاحقًا، أو واصل التدريب كضيف. تعمل القراءة والتعرّف على التلاوة دون اتصال بعد حفظ الملفات المطلوبة، أما الصوت المرجعي فيعتمد على المقاطع المحفوظة.

جرّب مقطعًا قصيرًا وأخبرنا بما يحتاج إلى تحسين. قد يخطئ التتبّع الآلي، وهو وسيلة للمراجعة ولا يغني عن التعلّم على يد معلّم متقن.

## First seven days: no paid promotion

1. Launch day: owner approves copy and shares the link with a small trusted memorization group. Ask for phone/browser, passage, and a short description of any issue.
2. Day 2: collect reports in one issue list; fix blocking problems before wider sharing.
3. Day 3: prepare a short screen demonstration showing search, recitation, and Teacher help, using reference or volunteered audio only with permission.
4. Day 4: owner seeks permission from relevant Quran teachers and community-group moderators before sharing. Do not send unsolicited bulk messages.
5. Day 5: publish a brief getting-started/offline guide and invite specific feedback.
6. Day 6: review volunteered tester feedback and any existing aggregate visit information cautiously; visitors can include bots. Do not add analytics infrastructure in this release.
7. Day 7: summarize what worked, remaining limitations, and the next release. Decide with the owner whether to widen the beta. Contact Quran Foundation separately when Tajweed is ready, as previously requested.

## Remembered product direction

The owner's stated plan is to build standalone **Android and iPhone apps if the web app attracts sustained use**. Keep a shared core for Quran display, tracking, and Teacher logic. Consider Android first, then iPhone; evaluate microphone reliability, model memory, offline storage, and background interruptions before choosing a wrapper or native implementation. iPhone builds can use cloud Mac infrastructure. Agree on the demand threshold with the owner using repeat practice, mobile demand, and feedback; no user-count threshold or delivery date has been promised.
