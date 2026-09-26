# Changelog

## [1.1.3](https://github.com/rafalpodles/board-planner/compare/v1.1.2...v1.1.3) (2026-09-26)


### Bug Fixes

* a closed save bar no longer holds its last summary (BP-738) ([7f713fb](https://github.com/rafalpodles/board-planner/commit/7f713fb6ff55fbee76422f43d1063df90f251b33))
* a custom field name is checked in the write, so two at once cannot both take it (BP-782 review) ([00ff63b](https://github.com/rafalpodles/board-planner/commit/00ff63b3ef5da400954b76fd7b1820695a5c0c24))
* a field name is compared by case only, the same rule everywhere, and only when it changes (BP-782 review) ([d9a02ad](https://github.com/rafalpodles/board-planner/commit/d9a02ad3cb2f06e96d76078148c5274943b201b6))
* a field name is written only when it changes, and never with a control character (BP-782 review) ([4beec17](https://github.com/rafalpodles/board-planner/commit/4beec17f10f721803b3472d8b3eee1cdd25203e2))
* a link or a branch that changed is recorded even when its shown form did not (BP-742 review) ([b9326c8](https://github.com/rafalpodles/board-planner/commit/b9326c898b6ac53a12fe157e09d746d36e65b1f5))
* a members read already out when an access change lands no longer puts the list back (BP-784 review) ([2abb29e](https://github.com/rafalpodles/board-planner/commit/2abb29e4c126ef711d4c3ea0f79a56a3f4a34707))
* a PM settings save writes only what it sent, over the MCP list it merged tokens from (BP-786) ([1f12d8d](https://github.com/rafalpodles/board-planner/commit/1f12d8d9bbec231989c4b4757e95bca7ec44089f))
* a project or members read that was superseded no longer replaces what the page holds (BP-784) ([7105106](https://github.com/rafalpodles/board-planner/commit/710510696420f13332e004f2ac55e0ef27fad282))
* an id sent in upper case is written and audited under the id as stored (BP-782 review) ([7065340](https://github.com/rafalpodles/board-planner/commit/706534059fbc2db2c74a624484fef1d651534070))
* an unsaved estimate choice of a removed field falls back to the saved one, not to None (BP-785 review) ([5693cd7](https://github.com/rafalpodles/board-planner/commit/5693cd7a240cc0a458843c550cba96ef315b6097))
* board access can be changed only once the list has been read, and says so when it cannot be (BP-784 review) ([7b9bef4](https://github.com/rafalpodles/board-planner/commit/7b9bef4b5ed8e81f4c84dc8b4b839c6c325e1996))
* board access waits for Save and every grant is audited (BP-741) ([6c2766e](https://github.com/rafalpodles/board-planner/commit/6c2766ef7a961f61b1414aa3a972ac3e98db4d85))
* hold the count bound open, and say nothing about an empty header (BP-774 review) ([c4ac782](https://github.com/rafalpodles/board-planner/commit/c4ac7825065b4d233354431fd8318801b42de2ff))
* key order is no change, null still clears a field, and demo rows carry their lines (BP-742 review) ([aa8f85e](https://github.com/rafalpodles/board-planner/commit/aa8f85ee9d2e5d20d26a9dd27777fb245a6a642f))
* MCP OAuth connect, callback and disconnect write only their own fields and are audited (BP-782) ([c7b7353](https://github.com/rafalpodles/board-planner/commit/c7b73533bd51aae61d8bb4a80850e23a61011307))
* nothing a URL or a typed name carries can leak into or forge an audit line (BP-742 review) ([930bc63](https://github.com/rafalpodles/board-planner/commit/930bc630c89965abf40ab80cdc8e06f59d2299d0))
* null clears every settings field, a name cannot be left empty, and capability URLs show only where they point (BP-742 review) ([c7db657](https://github.com/rafalpodles/board-planner/commit/c7db657678dcc3715dab7b0a07fbbd09ba22e9b9))
* OAuth fields are written only to the server at the address they were fetched for (BP-782 review) ([11d51bc](https://github.com/rafalpodles/board-planner/commit/11d51bccbf20cd918a41cf0eeee012af5229711e))
* one's own step-down waits when a change before it was refused (BP-741 review) ([a9401ad](https://github.com/rafalpodles/board-planner/commit/a9401ad6161831a00b43e19525625491148925cf))
* pin the quiet period off its boundary, and name what the bound does not do (BP-774 review) ([1b23af8](https://github.com/rafalpodles/board-planner/commit/1b23af86d870edc955478d6c87274b0f3e875095))
* project settings save bar, staged access and default agent, and an audit log with values (BP-738, BP-740, BP-741, BP-742) ([208abd0](https://github.com/rafalpodles/board-planner/commit/208abd01770143c2ee062918d928330a2f400f03))
* project settings save bar, staged access and default agent, and an audit log with values (BP-738, BP-740, BP-741, BP-742) ([#459](https://github.com/rafalpodles/board-planner/issues/459)) ([208abd0](https://github.com/rafalpodles/board-planner/commit/208abd01770143c2ee062918d928330a2f400f03))
* settings writes are atomic and audited, and a PM save keeps what it did not send (BP-782, BP-786) ([3778a02](https://github.com/rafalpodles/board-planner/commit/3778a026b2c8219e49ad4cc936ae6c252eb20b19))
* settings writes are atomic and audited, and a PM save keeps what it did not send (BP-782, BP-786) ([#461](https://github.com/rafalpodles/board-planner/issues/461)) ([3778a02](https://github.com/rafalpodles/board-planner/commit/3778a026b2c8219e49ad4cc936ae6c252eb20b19))
* stepping down is saved last, and staged access cannot be changed mid-save (BP-741 review) ([3c79dd2](https://github.com/rafalpodles/board-planner/commit/3c79dd2a7655690281e968aff08e5f2c7a175602))
* the audit reports what a write stored, and a failure after it cannot lose the entry (BP-742 review) ([a3bf6ed](https://github.com/rafalpodles/board-planner/commit/a3bf6ed78704bfafa1aa9fe5f9bc523cea350cf8))
* the default agent waits for Save and is audited (BP-740) ([71bc736](https://github.com/rafalpodles/board-planner/commit/71bc736b48dc7bcf370a30cbea5200928eff73bb))
* the ignored-header warning names how many entries it carried (BP-774) ([1adaff6](https://github.com/rafalpodles/board-planner/commit/1adaff650adaa5c44c415930ceb1b444f103b0a0))
* the ignored-header warning reports how many entries it carried (BP-774) ([316fa0d](https://github.com/rafalpodles/board-planner/commit/316fa0db960044d8d6a4860d140733d82eb75f7d))
* the PM launcher clears the save bar at the end of the page and on a phone (BP-783) ([f6598aa](https://github.com/rafalpodles/board-planner/commit/f6598aa47f3e8af11e804448b04cff41101aff6e))
* the project audit log records each setting before and after (BP-742) ([58ccddf](https://github.com/rafalpodles/board-planner/commit/58ccddf3b2d5ab2cbdfd22a0c0cf72f78b3f7ab9))
* the save bar clears the PM launcher, superseded reads change nothing, and the estimate field waits for Save (BP-783, BP-784, BP-785) ([942781f](https://github.com/rafalpodles/board-planner/commit/942781f0d22b75e427c56014a92a851b80c3acbc))
* the save bar clears the PM launcher, superseded reads change nothing, and the estimate field waits for Save (BP-783, BP-784, BP-785) ([#460](https://github.com/rafalpodles/board-planner/issues/460)) ([942781f](https://github.com/rafalpodles/board-planner/commit/942781f0d22b75e427c56014a92a851b80c3acbc))
* the save bar rests at the foot of the page on a short section, and its buttons wrap clear of the launcher (BP-783 review) ([2f3d138](https://github.com/rafalpodles/board-planner/commit/2f3d1381942ed7f7786dcba61c33ba9954394b97))
* the sprint estimate field waits for Save like the rest of the page (BP-785) ([b92095a](https://github.com/rafalpodles/board-planner/commit/b92095afd086052a30f2e37bc4938088778b987b))
* webhook, team channel and custom field edits are written in one step and audited from it (BP-782) ([a517433](https://github.com/rafalpodles/board-planner/commit/a5174332f325a8074ffc48aa407ad07afadc5607))

## [1.1.2](https://github.com/rafalpodles/board-planner/compare/v1.1.1...v1.1.2) (2026-09-22)


### Bug Fixes

* a machine that refuses its checkout is not live for the board, and says why (BP-777) ([4457877](https://github.com/rafalpodles/board-planner/commit/4457877824373ef1775d7edda12309a705a7cd3b))
* a shadowed plain cookie cannot cancel or take over a prefixed session (BP-773); narrow the faked-heading filter (BP-780) ([4ea359e](https://github.com/rafalpodles/board-planner/commit/4ea359e8b47fc7192038eddc4d473cd469e36fb4))
* compose derives the session cookie's security from the instance's origins (BP-773) ([505f734](https://github.com/rafalpodles/board-planner/commit/505f734dc55ebf5b577478f67889dcf3615cea4e))
* logout revokes every session the jar carries, and a revoked prefixed cookie no longer hides a live plain one (BP-773) ([37be711](https://github.com/rafalpodles/board-planner/commit/37be711fbd0ef7a2160579c0224e1184a29e77be))
* **menubar:** find the worker's socket where a deep state dir moves it (BP-778) ([f8cd57d](https://github.com/rafalpodles/board-planner/commit/f8cd57db822285b6643df28e9d6e8974687f5203))
* **menubar:** keep a hand-set commit identity when the same account is re-picked (BP-779) ([ebc6f4b](https://github.com/rafalpodles/board-planner/commit/ebc6f4b54d90f79d70453c10f1aa957a5e0b8b8a))
* **menubar:** refuse a control socket answered by another user's process (BP-778) ([975c3b1](https://github.com/rafalpodles/board-planner/commit/975c3b11d7604fede353881d1d80a97a7fa71e1d))
* **menubar:** refuse a relocated socket whose directory is not private; one socket path for every spelling of the state dir (BP-778) ([78b2af7](https://github.com/rafalpodles/board-planner/commit/78b2af7dbd402a01ded62c52969c50bf49926cbd))
* npm start listens on the PORT set in .env (BP-775) ([33e8e18](https://github.com/rafalpodles/board-planner/commit/33e8e18df2848762ee56792bf1dd977a33a85518))
* release, worker and self-hosting fixes (BP-773, BP-777, BP-779, BP-780, BP-776, BP-778, BP-775, BP-768, BP-772, BP-774) ([a7a5004](https://github.com/rafalpodles/board-planner/commit/a7a50042fff6947679fc004dfad77cf36ff32d28))
* the Workers list says a refused checkout as a sentence (BP-777) ([1067d28](https://github.com/rafalpodles/board-planner/commit/1067d28386b737d434c71dc5fa5ad0bc72907750))
* under auto, a sign-in over https gets the secure cookie; 1 refuses an https PUBLIC_ORIGIN (BP-773) ([bb4a09c](https://github.com/rafalpodles/board-planner/commit/bb4a09c7977a12a26ee378e48105210bce75aecc))
* warn once when X-Forwarded-For arrives while TRUSTED_PROXY_HOPS is 0 (BP-774) ([3ec15cf](https://github.com/rafalpodles/board-planner/commit/3ec15cfbe0ac9a93be53044c2074c95fafa3570e))
* **worker:** commit as the pinned GitHub account and name it in preflight (BP-779) ([cf894b0](https://github.com/rafalpodles/board-planner/commit/cf894b034a28a6ac7c4adede624cd18db1198893))
* **worker:** keep the control socket under the 104-byte limit for a deep state dir (BP-778) ([ce0c5e2](https://github.com/rafalpodles/board-planner/commit/ce0c5e2dcb98e4bb2c9e8f8dea96514cecca2c5d))
* **worker:** list only checks that saw the delivered code, keep the agent out of the worker's section, promise checks only when composed (BP-780) ([331fa25](https://github.com/rafalpodles/board-planner/commit/331fa25350d80bb2ddc04d2efd1874def5abca57))
* **worker:** list the checks a run passed on its pull request (BP-780) ([4aabd3e](https://github.com/rafalpodles/board-planner/commit/4aabd3e799379153ae58504d46b1dd04b7b7fdc9))
* **worker:** preflight warns rather than fails a machine with no git identity, names a missing token, and refuses CR and NUL in a set identity (BP-779) ([3a70aba](https://github.com/rafalpodles/board-planner/commit/3a70aba4568ae41eebdca4033d9d74ba399748e9))
* **worker:** re-read repos.json even when the server refuses the state GET (BP-776) ([fae1bdf](https://github.com/rafalpodles/board-planner/commit/fae1bdf5c46c8fba9f878bac5a70c24161b9c77e))
* **worker:** read the step at its own position, and strip every heading shape a summary could fake (BP-780) ([aea1a41](https://github.com/rafalpodles/board-planner/commit/aea1a41c52b5c21d90db41b6f544f86c03a0cf0d))
* **worker:** report the release the worker was built from (BP-768) ([c74f796](https://github.com/rafalpodles/board-planner/commit/c74f796f2517fa886c0e00d67b98f1eb8f6a8c35))

## [1.1.1](https://github.com/rafalpodles/board-planner/compare/v1.1.0...v1.1.1) (2026-09-22)


### Bug Fixes

* **ci:** pass secrets to the called release workflow, so a release-please release can sign ([4a326bf](https://github.com/rafalpodles/board-planner/commit/4a326bf986b60f6b4c270661b1f912b896386834))
* **ci:** pass secrets to the called release workflow, so a release-please release can sign (BP-767) ([829e162](https://github.com/rafalpodles/board-planner/commit/829e1629f248d6ddf862a92dcfaacdf632e60e76))

## [1.1.0](https://github.com/rafalpodles/board-planner/compare/v1.0.1...v1.1.0) (2026-09-22)


### Features

* publish a multi-arch Docker image to GHCR on every release (BP-766) ([3c2d1c6](https://github.com/rafalpodles/board-planner/commit/3c2d1c656c18bdbdfe91589fa67c2b2a5ba2b6ca))


### Bug Fixes

* a suggestion list keeps its selection when its data refreshes ([1cbb555](https://github.com/rafalpodles/board-planner/commit/1cbb555b481f0747e32038d441cda810b457781e))
* build links from the runtime origin, not a build-time NEXT_PUBLIC_APP_URL (BP-766) ([97f078a](https://github.com/rafalpodles/board-planner/commit/97f078a3d073eff9f10d81351b4a91d3a1bd727c))
* compose passes .env through, Enrol dialog drops CP_API_TOKEN (BP-769) ([db93c0d](https://github.com/rafalpodles/board-planner/commit/db93c0de6d2e3dbdaf43d35779c6825cdfd182a0))
* compose still honours NEXT_PUBLIC_APP_URL as PUBLIC_ORIGIN; document upgrading and clone builds (BP-766 review) ([68414c5](https://github.com/rafalpodles/board-planner/commit/68414c5992f87523bc6d26a5c98c5521a2289ac9))
* keep the selected suggestion by id, and keep a dismissed list shut ([1004cfd](https://github.com/rafalpodles/board-planner/commit/1004cfd4593afdf5b5685bb6ff52123547f55326))
* log a worker enrolment refused for want of PUBLIC_ORIGIN (BP-766 review) ([ada9f1a](https://github.com/rafalpodles/board-planner/commit/ada9f1a9d4788e4933a0c34d8312c7f20b15cabe))
* pass every .env variable through docker compose (BP-769) ([3d2cf51](https://github.com/rafalpodles/board-planner/commit/3d2cf513cd85b793209f4f6c51efd14cbbcf5136))
* the Enrol dialog no longer asks for CP_API_TOKEN (BP-769) ([5b8e143](https://github.com/rafalpodles/board-planner/commit/5b8e14377855c5b13cb6b21be6cbcfbb5fab40bd))
* the Enrol dialog says to chmod 600 the token file (BP-769) ([4377219](https://github.com/rafalpodles/board-planner/commit/437721944c4e05b914b25a2fa2339bffb7b29772))
* **worker:** an unreadable enrolment token file only matters before registration (BP-769) ([1a943f2](https://github.com/rafalpodles/board-planner/commit/1a943f2ef5040961184146e3a96be7599d59e618))
* **worker:** surface why an enrolment token file cannot be read (BP-769) ([4257614](https://github.com/rafalpodles/board-planner/commit/4257614c92c494a971b65d7a7a31cc9b4bd4aae7))
