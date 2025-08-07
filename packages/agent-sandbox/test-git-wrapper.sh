#!/bin/bash

# Test script for git wrapper functionality
echo "Testing git wrapper..."

# Test 1: Normal git commands should work
echo -e "\n1. Testing normal git status (should succeed):"
./template/scripts/git-wrapper.sh status
echo "Exit code: $?"

# Test 2: git commit --no-verify should be blocked
echo -e "\n2. Testing git commit --no-verify (should fail):"
./template/scripts/git-wrapper.sh commit --no-verify -m "test"
echo "Exit code: $?"

# Test 3: git commit -n should be blocked
echo -e "\n3. Testing git commit -n (should fail):"
./template/scripts/git-wrapper.sh commit -n -m "test"
echo "Exit code: $?"

# Test 4: git push --force should be blocked
echo -e "\n4. Testing git push --force (should fail):"
./template/scripts/git-wrapper.sh push --force origin main
echo "Exit code: $?"

# Test 5: git push --force-with-lease should be blocked
echo -e "\n5. Testing git push --force-with-lease (should fail):"
./template/scripts/git-wrapper.sh push --force-with-lease origin main
echo "Exit code: $?"

# Test 6: Normal git commit should work
echo -e "\n6. Testing normal git commit (should succeed - will fail if not in repo):"
./template/scripts/git-wrapper.sh commit -m "test"
echo "Exit code: $?"

echo -e "\nAll tests completed!"