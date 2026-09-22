# Changelog

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
