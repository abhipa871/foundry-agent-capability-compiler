.PHONY: setup dev lint test test-integration eval build
setup:
	npm ci
dev:
	npm run dev
lint:
	npm run lint
test:
	npm test
test-integration:
	npm run test:integration
eval:
	npm run eval
build:
	npm run build
