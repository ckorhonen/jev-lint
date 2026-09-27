# acme-app

The shared (JVM) layer of the Acme app: repositories, ViewModels and domain logic used by the
Android client. Kotlin, coroutines/Flow, `androidx.lifecycle` ViewModel, OkHttp.
`gradle test` builds and runs the tests.

- `src/main/kotlin/com/acme/app/data/` — models and repository interfaces
- `src/test/kotlin/com/acme/app/` — unit tests (kotlin.test + kotlinx-coroutines-test)
