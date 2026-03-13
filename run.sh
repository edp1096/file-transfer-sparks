#!/bin/bash

setsid sh -c "WEBKIT_DISABLE_COMPOSITING_MODE=1 ./file-transfer-sparks" > /dev/null 2>&1 &
sleep 0.1

# WEBKIT_DISABLE_COMPOSITING_MODE=1 ./file-transfer-sparks
