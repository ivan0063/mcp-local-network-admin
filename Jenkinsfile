pipeline {
    agent any

    environment {
        // ── Cambia estos 3 valores según tu entorno ────────────────
        REMOTE_HOST   = '192.168.50.180'            // IP del servidor con Docker
        SSH_CRED_ID   = 'remote-ssh-cred-melchior'  // Credencial SSH en Jenkins (usernamePassword)
        ENV_CRED_ID   = 'mcp-env-file'              // Secret file en Jenkins con el .env de la app
        // ──────────────────────────────────────────────────────────

        GIT_REPO       = 'https://github.com/ivan0063/mcp-local-network-admin.git'
        GIT_BRANCH     = 'main'
        DOCKER_IMAGE   = 'mcp-local-network-admin:latest'
        CONTAINER_NAME = 'mcp-local-network-admin'
        APP_PORT       = '3500'
        PROJECT_DIR    = 'mcp-local-network-admin'
        TAR_FILE       = 'mcp-local-network-admin.tar.gz'
    }

    stages {

        stage('Checkout') {
            steps {
                git branch: "${env.GIT_BRANCH}", url: "${env.GIT_REPO}"
                sh 'ls -la'
            }
        }

        stage('Verify Dockerfile') {
            steps {
                sh '''
                    if [ ! -f Dockerfile ]; then
                        echo "ERROR: Dockerfile not found"
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
                        usernamePassword(credentialsId: "${env.SSH_CRED_ID}", usernameVariable: 'SSH_USER', passwordVariable: 'SSH_PASS'),
                        file(credentialsId: "${env.ENV_CRED_ID}", variable: 'ENV_FILE')
                    ]) {
                        // Stop y limpieza del contenedor anterior
                        sh """
                            sshpass -p \${SSH_PASS} ssh -o StrictHostKeyChecking=no \${SSH_USER}@${REMOTE_HOST} "
                                set -x
                                docker ps -a --filter 'publish=${APP_PORT}' -q | xargs -r docker stop || true
                                docker ps -a --filter 'publish=${APP_PORT}' -q | xargs -r docker rm  || true
                                docker stop ${CONTAINER_NAME} || true
                                docker rm   ${CONTAINER_NAME} || true
                                rm -rf ${PROJECT_DIR} ${TAR_FILE}
                            "
                        """

                        // Empaquetar fuente (sin .git ni node_modules)
                        sh """
                            tar -czf ${TAR_FILE} \
                                --exclude='.git' \
                                --exclude='node_modules' \
                                * 2> tar-error.log || { cat tar-error.log; exit 1; }
                        """

                        // Transferir fuente y .env al servidor
                        sh """
                            sshpass -p \${SSH_PASS} scp -o StrictHostKeyChecking=no ${TAR_FILE}  \${SSH_USER}@${REMOTE_HOST}:.
                            sshpass -p \${SSH_PASS} scp -o StrictHostKeyChecking=no \${ENV_FILE} \${SSH_USER}@${REMOTE_HOST}:~/.mcp.env
                        """

                        // Extraer, build, verificar puerto, correr y limpiar
                        sh """
                            sshpass -p \${SSH_PASS} ssh -o StrictHostKeyChecking=no \${SSH_USER}@${REMOTE_HOST} "
                                set -x
                                mkdir -p ${PROJECT_DIR}
                                tar -xzf ${TAR_FILE} -C ${PROJECT_DIR} 2> tar-error.log || { cat tar-error.log; exit 1; }
                                cd ${PROJECT_DIR}
                                ls -la
                                docker build -t ${DOCKER_IMAGE} . 2> build-error.log || { cat build-error.log; exit 1; }
                                if ss -tuln | grep ':${APP_PORT}'; then
                                    echo 'Puerto ${APP_PORT} ocupado por un proceso no-Docker'
                                    lsof -i :${APP_PORT}
                                    exit 1
                                fi
                                docker run -d \
                                    --name ${CONTAINER_NAME} \
                                    --restart=unless-stopped \
                                    -p ${APP_PORT}:3000 \
                                    --env-file ~/.mcp.env \
                                    ${DOCKER_IMAGE} 2> run-error.log || { cat run-error.log; exit 1; }
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
            echo "Pipeline completado. MCP server corriendo en http://${REMOTE_HOST}:${APP_PORT}/mcp"
        }
        failure {
            echo 'Pipeline fallido. Revisa los logs para más detalles.'
        }
    }
}
