.PHONY: app test clean worker

test:
	swift test

# The app carries the worker — Contents/Resources/worker, which bundle.sh puts there. Building one
# without the other produces a bundle that installs, onboards, and then has nothing to run.
worker:
	@[ -d ../worker/node_modules ] || npm --prefix ../worker ci
	npm --prefix ../worker run build

# bundle.sh is the only thing that assembles the app. This target used to do its own copying and
# drifted from it: it never learned about the worker, so `make app` produced a bundle that could
# not work anywhere except a Board Planner checkout — and the app's own error message for that
# state said "reinstall", which never helped, because no reinstall of it would carry one.
app: test worker
	./bundle.sh release

clean:
	rm -rf .build CPMenubar.app
