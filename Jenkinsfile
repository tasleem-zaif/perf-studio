pipeline {
    agent none

    stages {

        stage('Prepare Environment') {
            steps {
                script {
                    env.ENVIRONMENT      = 'QA'
                    env.BRANCH_OR_TAG      = 'develop'
                    env.USER               = 'peako'
                    env.AGENT_LABEL        = 'peako'
                    env.CUSTOM_WORKSPACE   = '/var/www/html/perf-studio'
                }
            }
        }

        stage('Deploy') {
            agent {
                label "${env.AGENT_LABEL}"
            }

            steps {
                checkout scm
                script {
                    deployToServer()
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

def deployToServer() {

    echo "Deploying ${env.GIT_COMMIT} to ${env.ENVIRONMENT}"

    sh """
        sudo su - ${env.USER} -c '
            cd ${env.CUSTOM_WORKSPACE} && \\
            git stash && \\
            git fetch && \\
            git checkout $GIT_COMMIT && \\
            cd backend && npm install --omit=dev && cd .. && \\
            cd frontend && npm install && npm run build && cd .. && \\
            cd backend && pm2 restart perfstudio-backend --update-env  && \\
            pm2 save
        '
    """
}
