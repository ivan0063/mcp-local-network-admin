pipeline {
    agent any
    environment {
        GIT_REPO       = 'https://github.com/ivan0063/mcp-local-network-admin.git'
        DOCKER_IMAGE   = 'mcp-local-network-admin:latest'
        REMOTE_HOST    = '192.168.50.180'
        CONTAINER_NAME = 'mcp-local-network-admin'
        APP_PORT       = '3500'
        PROJECT_DIR    = 'mcp-local-network-admin'
        TAR_FILE       = 'mcp-local-network-admin.tar.gz'
    }
    stages {

        stage('Checkout') {
            steps {
                git branch: 'main', url: "${env.GIT_REPO}"
                sh 'ls -la'
            }
        }

        stage('Verify Dockerfile') {
            steps {
                sh '''
                    if [ ! -f Dockerfile ]; then
                        echo "ERROR: Dockerfile not found in repository"
                        exit 1
                    fi
                    cat Dockerfile
                '''
            }
        }

        stage('Transfer and Build on Remote') {
            steps {
                script {
                    withCredentials([
                        usernamePassword(credentialsId: 'remote-ssh-cred-melchior', usernameVariable: 'SSH_USER', passwordVariable: 'SSH_PASS'),
                        file(credentialsId: 'mcp-env-file', variable: 'ENV_FILE')
                    ]) {
                        // Stop and remove existing container, clean up old files
                        sh """
                            sshpass -p \${SSH_PASS} ssh -o StrictHostKeyChecking=no \${SSH_USER}@\${REMOTE_HOST} "
                                set -x
                                docker ps -a --filter 'publish=${APP_PORT}' -q | xargs -r docker stop || true
                                docker ps -a --filter 'publish=${APP_PORT}' -q | xargs -r docker rm || true
                                docker stop ${CONTAINER_NAME} || true
                                docker rm ${CONTAINER_NAME} || true
                                rm -rf ${PROJECT_DIR} ${TAR_FILE}
                            "
                        """

                        // Package source code
                        sh """
                            ls -la
                            tar -czf ${TAR_FILE} --exclude='.git' --exclude='node_modules' * 2> tar-error.log || { cat tar-error.log; exit 1; }
                        """

                        // Transfer source code and .env
                        sh """
                            sshpass -p \${SSH_PASS} scp -o StrictHostKeyChecking=no ${TAR_FILE} \${SSH_USER}@\${REMOTE_HOST}:.
                            sshpass -p \${SSH_PASS} scp -o StrictHostKeyChecking=no \${ENV_FILE} \${SSH_USER}@\${REMOTE_HOST}:~/.mcp.env
                        """

                        // Extract, build, check port, run and clean up
                        sh """
                            sshpass -p \${SSH_PASS} ssh -o StrictHostKeyChecking=no \${SSH_USER}@\${REMOTE_HOST} "
                                set -x
                                mkdir -p ${PROJECT_DIR}
                                tar -xzf ${TAR_FILE} -C ${PROJECT_DIR} 2> tar-error.log || { cat tar-error.log; exit 1; }
                                cd ${PROJECT_DIR}
                                ls -la
                                docker build -t ${DOCKER_IMAGE} . 2> build-error.log || { cat build-error.log; exit 1; }
                                if ss -tuln | grep ':${APP_PORT}'; then
                                    echo 'Port ${APP_PORT} is in use by a non-Docker process'
                                    lsof -i :${APP_PORT} > port.log
                                    cat port.log
                                    echo 'WARNING: Port ${APP_PORT} is occupied; free it manually or choose another port'
                                    exit 1
                                fi
                                docker run -d --name ${CONTAINER_NAME} --restart=unless-stopped -p ${APP_PORT}:3000 \
                                    --env-file ~/.mcp.env \
                                    ${DOCKER_IMAGE} 2> run-error.log || { cat run-error.log; echo 'Failed to run container'; exit 1; }
                                cd ..
                                rm -rf ${PROJECT_DIR} ${TAR_FILE} ~/.mcp.env
                                docker image prune -f
                                docker ps -a
                                docker logs ${CONTAINER_NAME} > container-logs.log 2>&1
                                cat container-logs.log
                            "
                        """
                    }
                }
            }
        }

    }
    post {
        always {
            cleanWs()
        }
        success {
            echo "Pipeline completed successfully! MCP server running on http://${REMOTE_HOST}:${APP_PORT}/mcp"
        }
        failure {
            echo 'Pipeline failed! Check the logs for details.'
        }
    }
}
