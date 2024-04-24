#!/bin/bash

# Function to parse .env file and set environment variables
load_env_file() {
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and lines starting with a #
    if [[ -n "$line" && ! "$line" =~ ^\#.* ]]; then
      export "$line"
    fi
  done < .env
}

# Check if the .env file exists and load it
if [ -f .env ]; then
  load_env_file
fi

# Use the environment variables from the .env file or set defaults
zeus_url="${HASURA_GRAPHQL_ENDPOINT:-http://localhost:7070}"
hasura_secret="${HASURA_GRAPHQL_ADMIN_SECRET:-default_secret}"

# Path to the zeus binary
zeus_path="./node_modules/.bin/zeus"

# Command to be executed using zeus
zeus_command="$zeus_path $zeus_url/v1/graphql ./generated --node --header=x-hasura-admin-secret:$hasura_secret"

# Execute the zeus command
$zeus_command
