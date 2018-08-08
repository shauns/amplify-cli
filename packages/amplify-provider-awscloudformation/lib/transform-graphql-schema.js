const inquirer = require('inquirer');
const fs = require('fs-extra');
const path = require('path');

const GraphQLTransform = require('graphql-transform').default;
const AppSyncDynamoDBTransformer = require('graphql-dynamodb-transformer').default;
const AppSyncAuthTransformer = require('graphql-auth-transformer').default;
const AppSyncTransformer = require('graphql-appsync-transformer').default;
const AppSyncConnectionTransformer = require('graphql-connection-transformer').default;

const category = 'api';
const parametersFileName = 'parameters.json';
const templateFileName = 'cloudformation-template.json';
const schemaFileName = 'schema.graphql';

async function transformGraphQLSchema(context, options) {
  let { resourceDir, parameters } = options;
  const { noConfig } = options;

  // Compilation during the push step
  if (!resourceDir) {
    const {
      resourcesToBeCreated,
      resourcesToBeUpdated,
    } = await context.amplify.getResourceStatus(category);
    let resources = resourcesToBeCreated.concat(resourcesToBeUpdated);
    resources = resources.filter(resource => resource.service === 'AppSync');
    // There can only be one appsync resource
    if (resources.length > 0) {
      const resource = resources[0];
      const { category, resourceName } = resource;
      const backEndDir = context.amplify.pathManager.getBackendDirPath();
      resourceDir = path.normalize(path.join(backEndDir, category, resourceName));
    } else {
      // No appsync resource to update/add
      return;
    }
  }

  const parametersFilePath = path.join(resourceDir, parametersFileName);


  if (!parameters && fs.existsSync(parametersFilePath)) {
    try {
      parameters = JSON.parse(fs.readFileSync(parametersFilePath));
    } catch (e) {
      parameters = {};
    }
  }

  const buildDir = `${resourceDir}/build`;
  const schemaFilePath = `${resourceDir}/${schemaFileName}`;

  fs.ensureDirSync(buildDir);
  // Transformer compiler code

  const transformerList = [
    new AppSyncTransformer(buildDir),
    new AppSyncDynamoDBTransformer(),
    new AppSyncConnectionTransformer(),
  ];

  if (parameters.AuthCognitoUserPoolId) {
    transformerList.push(new AppSyncAuthTransformer());
  }

  const transformer = new GraphQLTransform({
    transformers: transformerList,
  });

  const cfdoc = transformer.transform(fs.readFileSync(schemaFilePath, 'utf8'));
  fs.writeFileSync(`${resourceDir}/${templateFileName}`, JSON.stringify(cfdoc, null, 4), 'utf8');

  // Look for data sources in the cfdoc

  const dynamoResources = [];
  const cfResources = cfdoc.Resources;
  Object.keys(cfResources).forEach((logicalId) => {
    if (cfResources[logicalId].Type === 'AWS::DynamoDB::Table') {
      dynamoResources.push(logicalId);
    }
  });

  if (dynamoResources.length > 0 && !noConfig) {
    context.print.info(`We've detected ${dynamoResources.length} DynamoDB resources which would be created for you as a part of the AppSync service.`);
    if (await context.prompt.confirm('Do you want to use your own tables instead?')) {
      let continueConfiguringDyanmoTables = true;

      while (continueConfiguringDyanmoTables) {
        const cfTableConfigureQuestion = {
          type: 'list',
          name: 'cfDynamoTable',
          message: 'Choose a table to configure:',
          choices: dynamoResources,
        };

        const { cfDynamoTable } = await inquirer.prompt(cfTableConfigureQuestion);
        const dynamoAnswers = await askDynamoDBQuestions(context);

        // Would be used in the future to fill into the parameters.json file
        console.log(cfDynamoTable);
        console.log(dynamoAnswers);

        const confirmQuestion = {
          type: 'confirm',
          name: 'continueConfiguringDyanmoTables',
          message: 'Do you want to configure more tables?',
        };

        ({ continueConfiguringDyanmoTables } = await inquirer.prompt(confirmQuestion));
      }
    }
  }

  const jsonString = JSON.stringify(parameters, null, 4);

  fs.writeFileSync(parametersFilePath, jsonString, 'utf8');
}

async function askDynamoDBQuestions(context) {
  const dynamoDbTypeQuestion = {
    type: 'list',
    name: 'dynamoDbType',
    message: 'Choose a DynamoDB data source option',
    choices: [
      {
        name: 'Use DynamoDB table configured in the current Amplify project',
        value: 'currentProject',
      },
      {
        name: 'Create a new DynamoDB table',
        value: 'newResource',
      },
      {
        name: 'Use a DynamoDB table already deployed on AWS',
        value: 'cloudResource',
      },
    ],
  };
  while (true) {
    const dynamoDbTypeAnswer = await inquirer.prompt([dynamoDbTypeQuestion]);
    switch (dynamoDbTypeAnswer.dynamoDbType) {
      case 'currentProject': {
        const storageResources = context.amplify.getProjectDetails().amplifyMeta.storage || {};
        const dynamoDbProjectResources = [];
        Object.keys(storageResources).forEach((resourceName) => {
          if (storageResources[resourceName].service === 'DynamoDB') {
            dynamoDbProjectResources.push(resourceName);
          }
        });
        if (dynamoDbProjectResources.length === 0) {
          context.print.error('There are no DynamoDb resources configured in your project currently');
          break;
        }
        const dynamoResourceQuestion = {
          type: 'list',
          name: 'dynamoDbResources',
          message: 'Choose from one of the already configured DynamoDB tables',
          choices: dynamoDbProjectResources,
        };

        const dynamoResourceAnswer = await inquirer.prompt([dynamoResourceQuestion]);

        // return { resourceName: dynamoResourceAnswer["dynamoDbResources"] };
        return {
          'Fn::GetAtt': [
            `storage${dynamoResourceAnswer.dynamoDbResources}`,
            'Arn',
          ],
        };
      }
      case 'newResource': {
        let add;
        try {
          ({ add } = require('amplify-category-storage'));
        } catch (e) {
          context.print.error('Storage plugin not installed in the CLI. Please install it to use this feature');
          break;
        }
        return add(context, 'awscloudformation', 'DynamoDB')
          .then((resourceName) => {
            context.print.success('Succesfully added DynamoDb table locally');
            return {
              'Fn::GetAtt': [
                `storage${resourceName}`,
                'Arn',
              ],
            };
          });
      }
      case 'cloudResource': {
        const regions = await context.amplify.executeProviderUtils(context, 'awscloudformation', 'getRegions');

        const regionQuestion = {
          type: 'list',
          name: 'region',
          message: 'Please select a region:',
          choices: regions,
        };

        const regionAnswer = await inquirer.prompt([regionQuestion]);

        const dynamodbTables = await context.amplify.executeProviderUtils(context, 'awscloudformation', 'getDynamoDBTables', { region: regionAnswer.region });

        const dynamodbOptions = dynamodbTables.map(dynamodbTable => ({
          value: {
            resourceName: dynamodbTable.Name.replace(/[^0-9a-zA-Z]/gi, ''),
            region: dynamodbTable.Region,
            Arn: dynamodbTable.Arn,
            TableName: dynamodbTable.Name,
          },
          name: `${dynamodbTable.Name} (${dynamodbTable.Arn})`,
        }));

        if (dynamodbOptions.length === 0) {
          context.print.error('You do not have any DynamoDB tables configured for the selected region');
          break;
        }

        const dynamoCloudOptionQuestion = {
          type: 'list',
          name: 'dynamodbTableChoice',
          message: 'Please select a DynamoDB table:',
          choices: dynamodbOptions,
        };

        const dynamoCloudOptionAnswer = await inquirer.prompt([dynamoCloudOptionQuestion]);
        return dynamoCloudOptionAnswer.dynamodbTableChoice.Arn;
      }
      default: context.print.error('Invalid option selected');
    }
  }
}


module.exports = {
  transformGraphQLSchema,
};