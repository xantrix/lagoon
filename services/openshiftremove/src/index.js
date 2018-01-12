// @flow

const Promise = require("bluebird");
const OpenShiftClient = require('openshift-client');
const { logger } = require('@lagoon/commons/src/local-logging');
const { sendToLagoonLogs, initSendToLagoonLogs } = require('@lagoon/commons/src/logs');
const { consumeTasks, initSendToLagoonTasks } = require('@lagoon/commons/src/tasks');

const { getOpenShiftInfoForProject, deleteEnvironment } = require('@lagoon/commons/src/api');

initSendToLagoonLogs();
initSendToLagoonTasks();

const ocsafety = string => string.toLocaleLowerCase().replace(/[^0-9a-z-]/g,'-')

const messageConsumer = async function(msg) {
  const {
    projectName,
    branch,
    pullrequestNumber,
    type
  } = JSON.parse(msg.content.toString())

  logger.verbose(`Received RemoveOpenshift task for project ${projectName}, type ${type}, branch ${branch}, pullrequest ${pullrequestNumber}`);

  const result = await getOpenShiftInfoForProject(projectName);
  const projectOpenShift = result.project

  try {
    var safeProjectName = ocsafety(projectName)
    var openshiftConsole = projectOpenShift.openshift.console_url.replace(/\/$/, "");
    var openshiftToken = projectOpenShift.openshift.token || ""

    var openshiftProject
    var environmentName

    switch (type) {
      case 'pullrequest':
        environmentName = `pr-${pullrequestNumber}`
        openshiftProject = `${safeProjectName}-pr-${pullrequestNumber}`
        break;

      case 'branch':
        const safeBranchName = ocsafety(branch)
        environmentName = branch
        openshiftProject = `${safeProjectName}-${safeBranchName}`
        break;
    }

  } catch(error) {
    logger.warn(`Error while loading openshift information for project ${projectName}, error ${error}`)
    throw(error)
  }

  logger.info(`Will remove OpenShift Project ${openshiftProject} on ${openshiftConsole}`);

  // OpenShift API object
  const openshift = new OpenShiftClient.OApi({
    url: openshiftConsole,
    insecureSkipTlsVerify: true,
    auth: {
      bearer: openshiftToken
    },
  });


  // Check if project exists
  try {
    const projectsGet = Promise.promisify(openshift.projects(openshiftProject).get, { context: openshift.projects(openshiftProject) })
    await projectsGet()
  } catch (err) {
    // a non existing project also throws an error, we check if it's a 404, means it does not exist, and we assume it's already removed
    if (err.code == 404) {
      logger.info(`${openshiftProject} does not exist, assuming it was removed`);
      sendToLagoonLogs('success', projectName, "", "task:remove-openshift:finished",  {},
        `*[${projectName}]* remove \`${openshiftProject}\``
      )
      return
    } else {
      logger.error(err)
      throw new Error
    }
  }

  // Project exists, let's remove it
  try {
    const projectsDelete = Promise.promisify(openshift.projects(openshiftProject).delete, { context: openshift.projects(openshiftProject) })
    await projectsDelete()
    sendToLagoonLogs('success', projectName, "", "task:remove-openshift:finished",  {},
      `*[${projectName}]* remove \`${openshiftProject}\``
    )
  } catch (err) {
    logger.error(err)
    throw new Error
  }

  // Update GraphQL API that the Environment has been deleted
  try {
    await deleteEnvironment(environmentName, projectName)
    logger.info(`${openshiftProject}: Deleted Environment '${environmentName}' in API`)
  } catch (err) {
    logger.error(err)
    throw new Error
  }

}

const deathHandler = async (msg, lastError) => {

  const {
    projectName,
    branch,
    pullrequestNumber,
    type
  } = JSON.parse(msg.content.toString())

  const openshiftProject = ocsafety(`${projectName}-${branch || pullrequestNumber}`)

  sendToLagoonLogs('error', projectName, "", "task:remove-openshift:error",  {},
`*[${projectName}]* remove \`${openshiftProject}\` ERROR:
\`\`\`
${lastError}
\`\`\``
  )

}

const retryHandler = async (msg, error, retryCount, retryExpirationSecs) => {
  const {
    projectName,
    branch,
    pullrequestNumber,
    type
  } = JSON.parse(msg.content.toString())

  const openshiftProject = ocsafety(`${projectName}-${branch || pullrequestNumber}`)

  sendToLagoonLogs('warn', projectName, "", "task:remove-openshift:retry", {error: error, msg: JSON.parse(msg.content.toString()), retryCount: retryCount},
`*[${projectName}]* remove \`${openshiftProject}\` ERROR:
\`\`\`
${error}
\`\`\`
Retrying in ${retryExpirationSecs} secs`
  )
}

consumeTasks('remove-openshift', messageConsumer, retryHandler, deathHandler)
