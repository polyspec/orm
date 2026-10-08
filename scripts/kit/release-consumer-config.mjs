// The rules of the sections `consumers` and `proof` of config/release.json that the schema cannot express. release.mjs
// loadConfig calls it, so every release step rejects an inconsistent section. It reads the configuration only.
//
//   consumers.<npm|composer> = { directory, smoke }   the consumer project of the archives of that kind: `directory` holds
//                                                      its committed manifest and lock; `smoke` maps each package that the
//                                                      project installs to the command that checks it
//   proof.gitTag = { <manifest>: { kind, name, smoke } }  how the release proof installs a manifest that a tag releases
//                                                      through git (`git-tag` in `manifests`)

/** The package kinds that have a consumer project, and the kind of the git-tag manifests with their file names. */
export const CONSUMER_KINDS = ['npm', 'composer'];
export const GIT_TAG_KINDS = { python: 'pyproject.toml', rust: 'Cargo.toml' };

const command = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item !== '');

/** The problems of `consumers` and `proof` of a configuration that passed the schema, as sentences without the file name. */
export function consumerConfigProblems(config) {
  const problems = [];
  const bad = (where, value) => problems.push(`${where} needs a command, a non-empty array of non-empty strings, found ${JSON.stringify(value)}`);
  if (config.consumers) {
    const directories = new Set();
    for (const kind of CONSUMER_KINDS) {
      const names = config.packages.filter(item => item.kind === kind).map(({ name }) => name);
      const consumer = config.consumers[kind];
      if (!consumer) {
        if (names.length) problems.push(`consumers.${kind} is missing; the ${kind} packages [${names.join(', ')}] need a consumer project that installs them`);
        continue;
      }
      if (!names.length) problems.push(`consumers.${kind} is set but packages lists no ${kind} package`);
      if (directories.has(consumer.directory)) problems.push(`consumers.${kind}.directory ${consumer.directory} is also the directory of another consumer`);
      directories.add(consumer.directory);
      if (typeof consumer.smoke !== 'object' || consumer.smoke === null || Array.isArray(consumer.smoke) || !Object.keys(consumer.smoke).length) {
        problems.push(`consumers.${kind}.smoke needs one entry per installed package, an object from a package name to its command`);
        continue;
      }
      for (const [name, smoke] of Object.entries(consumer.smoke)) {
        if (!names.includes(name)) problems.push(`consumers.${kind}.smoke.${name} is not a ${kind} package of packages [${names.join(', ')}]`);
        if (!command(smoke)) bad(`consumers.${kind}.smoke.${name}`, smoke);
      }
    }
  }
  if (config.proof) {
    const gitTag = Object.entries(config.manifests).filter(([, mode]) => mode === 'git-tag').map(([file]) => file);
    for (const [file, entry] of Object.entries(config.proof.gitTag)) {
      if (config.manifests[file] !== 'git-tag') problems.push(`proof.gitTag.${file} is not a manifest with the mode "git-tag" in manifests`);
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        problems.push(`proof.gitTag.${file} needs an object { kind, name, smoke }`);
        continue;
      }
      const base = file.split('/').at(-1);
      if (!(entry.kind in GIT_TAG_KINDS)) problems.push(`proof.gitTag.${file}.kind is ${JSON.stringify(entry.kind)}, the allowed values are ${Object.keys(GIT_TAG_KINDS).join(', ')}`);
      else if (GIT_TAG_KINDS[entry.kind] !== base) problems.push(`proof.gitTag.${file}.kind ${entry.kind} installs a ${GIT_TAG_KINDS[entry.kind]}, not a ${base}`);
      if (typeof entry.name !== 'string' || !entry.name) problems.push(`proof.gitTag.${file}.name needs the package name, a non-empty string`);
      if (!command(entry.smoke)) bad(`proof.gitTag.${file}.smoke`, entry.smoke);
    }
    for (const file of gitTag) if (!(file in config.proof.gitTag)) problems.push(`proof.gitTag lacks ${file}, which manifests releases by "git-tag"`);
  }
  return problems;
}
