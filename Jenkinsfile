pipeline {
    agent none

    environment {
        ENVIRONMENT      = 'QA'
        BRANCH_OR_TAG    = 'develop'
        DEPLOY_USER      = 'peako'
        AGENT_LABEL      = 'peako'
        CUSTOM_WORKSPACE = '/var/www/html/perf-studio'
    }

    stages {

        stage('Prepare Environment') {
            steps {
                echo "Deploying to ${ENVIRONMENT}"
                echo "Agent label : ${AGENT_LABEL}"
                echo "Workspace   : ${CUSTOM_WORKSPACE}"
                echo "Git commit  : ${GIT_COMMIT}"
            }
        }

        stage('Deploy') {
            agent {
                label "${AGENT_LABEL}"
            }

            stages {

                stage('Checkout Code') {
                    steps {
                        sh """
                            sudo su - ${DEPLOY_USER} -c '
                                cd ${CUSTOM_WORKSPACE} && \
                                git stash && \
                                git fetch && \
                                git checkout ${GIT_COMMIT} 
                                
                            '
                        """
                    }
                }

                stage('Deploy Backend') {
                    steps {
                        sh """
                            sudo su - ${DEPLOY_USER} -c '
                                set -e
                                cd ${CUSTOM_WORKSPACE}/backend
                                npm install --omit=dev
                            '
                        """
                    }
                }

                stage('Build Frontend') {
                    steps {
                        sh """
                            sudo su - ${DEPLOY_USER} -c '
                                set -e
                                cd ${CUSTOM_WORKSPACE}/frontend
                                npm install
                                npm run build
                            '
                        """
                    }
                }

                stage('Restart Application') {
                    steps {
                        sh """
                            sudo su - ${DEPLOY_USER} -c '
                                set -e
                                cd ${CUSTOM_WORKSPACE}/backend
                                pm2 restart perfstudio-backend --update-env || pm2 start src/index.js --name perfstudio-backend
                                pm2 save
                            '
                        """
                    }
                }
            }
        }
    }

    post {
        success {
            echo '✅ QA deployment completed successfully.'
        }
        failure {
            echo '❌ QA deployment failed.'
        }
    }
}
