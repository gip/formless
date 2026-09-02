APP_NAME ?= WebMCP Browser
EXECUTABLE = WebMCPBrowser
CONFIG ?= release
BUILD_DIR = build
APP = $(BUILD_DIR)/$(APP_NAME).app
BIN = .build/$(CONFIG)/$(EXECUTABLE)
RESOURCE_BUNDLE = .build/$(CONFIG)/$(EXECUTABLE)_$(EXECUTABLE).bundle

.PHONY: app build run test check media-check reload-check permissions clean

build:
	swift build -c $(CONFIG)

## Assemble a real .app: WKWebView needs a bundle for ATS and Bundle.module needs Contents/Resources.
app: build
	rm -rf "$(APP)"
	mkdir -p "$(APP)/Contents/MacOS" "$(APP)/Contents/Resources"
	cp "$(BIN)" "$(APP)/Contents/MacOS/$(EXECUTABLE)"
	cp Support/Info.plist "$(APP)/Contents/Info.plist"
	@test -d "$(RESOURCE_BUNDLE)" || { echo "error: $(RESOURCE_BUNDLE) not found; the polyfill would be missing"; exit 1; }
	cp -R "$(RESOURCE_BUNDLE)" "$(APP)/Contents/Resources/"
	codesign --force --sign - "$(APP)"
	@echo "built $(APP)"

run: app
	open "$(APP)"

## Contract test for the JS half of the bridge; needs node, not a browser.
test:
	node Tests/polyfill.test.mjs

## End-to-end: drives both bridge channels inside a real WKWebView. Needs a GUI login session.
check: test app
	"$(APP)/Contents/MacOS/$(EXECUTABLE)" --selfcheck "file://$(CURDIR)/Tests/fixture.html" --invoke fixture.echo --args '{"message":"ok"}' > /dev/null
	@! "$(APP)/Contents/MacOS/$(EXECUTABLE)" --selfcheck "file://$(CURDIR)/Tests/no-tools.html" --settle 1 > /dev/null
	@echo "bridge checks passed: tools discovered on the fixture, none on a plain page"

## Microphone, Web Speech, and audio output. Opens the app via LaunchServices; on a machine
## that has not granted access yet, run `make permissions` first.
media-check: app
	./Tests/media-check.sh

## Regression test for the web-content-process leak. Needs something serving URL (default
## http://localhost:3000). Override with: make reload-check URL=https://example.com
reload-check: app
	./Tests/reload-check.sh $(URL)

## Triggers the macOS microphone and speech-recognition prompts up front.
permissions: app
	open "$(APP)" --args --request-permissions --out /dev/stdout

clean:
	rm -rf .build "$(BUILD_DIR)"
