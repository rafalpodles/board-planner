APP := CPMenubar.app

.PHONY: app test clean

test:
	swift test

app: test
	swift build -c release
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS
	cp Resources/Info.plist $(APP)/Contents/Info.plist
	cp .build/release/CPMenubar $(APP)/Contents/MacOS/CPMenubar
	codesign --force --sign - $(APP)

clean:
	rm -rf .build $(APP)
