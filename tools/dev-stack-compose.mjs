export function developerComposeArgs(...composeArgs) {
  return ["compose", "-f", "docker-compose.yml", ...composeArgs];
}
