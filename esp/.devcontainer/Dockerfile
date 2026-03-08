FROM europe-docker.pkg.dev/csp-backends-dev-stg-88mg/emb-build-management/cspidf/build:0.0.12

USER root

RUN update-alternatives --install /usr/local/bin/usbip usbip `ls /usr/lib/linux-tools/*/usbip | tail -n1` 20

RUN chmod -R 775 /opt/esp/python_env/

RUN /opt/esp/idf/install.sh --enable-gdbgui esp32h2

# Needed in order to patch ESP-IDF
RUN chmod -R 777 /opt/esp/

RUN echo "source /opt/esp/idf/export.sh > /dev/null 2>&1" >> ~/.bashrc

ENV LC_ALL=C.UTF-8
ENV LANG=C.UTF-8

USER ${CONTAINER_USER}
ENV USER=${CONTAINER_USER}
WORKDIR /home/${CONTAINER_USER}

ENTRYPOINT [ "/opt/esp/entrypoint.sh" ]

CMD ["/bin/bash", "-c"]
