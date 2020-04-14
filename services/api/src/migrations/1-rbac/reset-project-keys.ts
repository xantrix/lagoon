import * as R from 'ramda';
import { parsePrivateKey } from 'sshpk';
import { logger } from '@lagoon/commons/src/local-logging';
import * as api from '@lagoon/commons/src/api';
import * as gitlabApi from '@lagoon/commons/dist/gitlabApi';
import { getKeycloakAdminClient } from '../../clients/keycloak-admin';
import { getSqlClient } from '../../clients/sqlClient';
import { query, prepare } from '../../util/db';
import { Group } from '../../models/group';
import { User } from '../../models/user';
import {
  generatePrivateKey,
  getSshKeyFingerprint,
} from '../../resources/sshKey';
import {
  selectUserIdsBySshKeyFingerprint,
  insertSshKey,
  addSshKeyToUser,
} from '../../resources/sshKey/sql';

interface GitlabProject {
  id: number;
  path: string;
  ssh_url_to_repo: string;
  namespace: {
    kind: string;
    path: string;
    full_path: string;
  };
}

const generatePrivateKeyEd25519 = R.partial(generatePrivateKey, ['ed25519']);

(async () => {
  const keycloakAdminClient = await getKeycloakAdminClient();

  const sqlClient = getSqlClient();

  const GroupModel = Group({ keycloakAdminClient });
  const UserModel = User({ keycloakAdminClient });

  const projectArgs = process.argv.slice(2);
  if (projectArgs.length === 0) {
    logger.error('You must pass project names as space separated options');
    return;
  }

  const allGitlabProjects = (await gitlabApi.getAllProjects()) as GitlabProject[];
  const projectRecords = await query(
    sqlClient,
    prepare(sqlClient, 'SELECT * FROM `project` WHERE name IN (:projects)')({
      projects: projectArgs,
    }),
  );

  for (const project of projectRecords) {
    logger.debug(`Processing ${project.name}`);

    const gitlabProject = R.find(
      (findProject: GitlabProject) =>
        api.sanitizeGroupName(findProject.path) === project.name,
    )(allGitlabProjects);

    // Load default group
    const projectGroupName = `project-${project.name}`;
    let keycloakGroup;
    try {
      keycloakGroup = await GroupModel.loadGroupByName(projectGroupName);
    } catch (err) {
      logger.error(`Could not load group ${projectGroupName}: ${err.message}`);
    }

    // //////////////////////
    // Delete Current Key //
    // //////////////////////
    if (R.prop('privateKey', project)) {
      let keyPair = {} as any;
      try {
        const privateKey = parsePrivateKey(R.prop('privateKey', project));
        const publicKey = privateKey.toPublic();

        keyPair = {
          ...keyPair,
          private: R.replace(/\n/g, '\n', privateKey.toString('openssh')),
          public: publicKey.toString(),
        };
      } catch (err) {
        throw new Error(
          `There was an error with the privateKey: ${err.message}`,
        );
      }
      const keyParts = keyPair.public.split(' ');

      // Delete users with current key
      const userRows = await query(
        sqlClient,
        selectUserIdsBySshKeyFingerprint(getSshKeyFingerprint(keyPair.public)),
      );

      for (const userRow of userRows) {
        const userId = R.prop('usid', userRow);

        try {
          await UserModel.deleteUser(userId);
        } catch (err) {
          if (!err.message.includes('User not found')) {
            throw new Error(err);
          }
        }

        // Delete public key
        await query(
          sqlClient,
          prepare(sqlClient, 'DELETE FROM ssh_key WHERE key_value = :key')({
            key: keyParts[1],
          }),
        );

        // Delete user_ssh_key link
        await query(
          sqlClient,
          prepare(sqlClient, 'DELETE FROM user_ssh_key WHERE usid = :usid')({
            usid: userId,
          }),
        );
      }

      // Delete current private key
      const nullQuery = prepare(
        sqlClient,
        'UPDATE project p SET private_key = NULL WHERE id = :pid',
      );
      await query(
        sqlClient,
        nullQuery({
          pid: project.id,
        }),
      );
    }

    // ////////////////
    // Make new key //
    // ////////////////

    // Generate new keypair
    const privateKey = generatePrivateKeyEd25519();
    const publicKey = privateKey.toPublic();

    const keyPair = {
      private: R.replace(/\n/g, '\n', privateKey.toString('openssh')),
      public: publicKey.toString(),
    };

    // Save the newly generated key
    const updateQuery = prepare(
      sqlClient,
      'UPDATE project p SET private_key = :pkey WHERE id = :pid',
    );
    await query(
      sqlClient,
      updateQuery({
        pkey: keyPair.private,
        pid: project.id,
      }),
    );

    // Find or create a user that has the public key linked to them
    const userRows = await query(
      sqlClient,
      selectUserIdsBySshKeyFingerprint(getSshKeyFingerprint(keyPair.public)),
    );
    const userId = R.path([0, 'usid'], userRows);

    let user;
    if (!userId) {
      try {
        user = await UserModel.addUser({
          email: `default-user@${project.name}`,
          username: `default-user@${project.name}`,
          comment: `autogenerated user for project ${project.name}`,
        });

        const keyParts = keyPair.public.split(' ');

        const {
          info: { insertId },
        } = await query(
          sqlClient,
          insertSshKey({
            id: null,
            name: 'auto-add via reset',
            keyValue: keyParts[1],
            keyType: keyParts[0],
            keyFingerprint: getSshKeyFingerprint(keyPair.public),
          }),
        );
        await query(
          sqlClient,
          addSshKeyToUser({ sshKeyId: insertId, userId: user.id }),
        );
      } catch (err) {
        logger.error(
          `Could not create default project user for ${project.name}: ${
            err.message
          }`,
        );
      }
    } else {
      // @ts-ignore
      user = await UserModel.loadUserById(userId);
    }

    // Add the user (with linked public key) to the default group as maintainer
    try {
      await GroupModel.addUserToGroup(user, keycloakGroup, 'maintainer');
    } catch (err) {
      logger.error(
        `Could not link user to default projet group for ${project.name}: ${
          err.message
        }`,
      );
    }

    try {
      await gitlabApi.addDeployKeyToProject(gitlabProject.id, keyPair.public);
    } catch (err) {
      if (!err.message.includes('has already been taken')) {
        throw new Error(
          `Could not add deploy_key to gitlab project ${
            gitlabProject.id
          }, reason: ${err}`,
        );
      }
    }
  }

  logger.info('Reset completed');

  sqlClient.destroy();
})();
