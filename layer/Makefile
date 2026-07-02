# Inflate the stored gzipped artifacts (geo/*.gz) back to raw files in the built
# layer. Content lands under nodejs/geo/ so it mounts at /opt/nodejs/geo (matching
# GEO_DATA_DIR). Runtime reads these raw buffers directly — the gzip is storage-only.
build-StateLookupBoundariesLayer:
	mkdir -p "$(ARTIFACTS_DIR)/nodejs/geo"
	for f in geo/*.gz; do gunzip -c "$$f" > "$(ARTIFACTS_DIR)/nodejs/geo/$$(basename "$$f" .gz)"; done
