// PDC status (Sets off IKE gongs)
// PDC -> XXX, A0,??,RL,RR,RCL,RCR,FL,FR,FCL,FCR,01->Active
function decode_pdc_status(data) {
	data.command = 'bro';
	data.value   = 'IKE gong/PDC status';

	const parse = {
		distance_rl : data.msg[1],
		distance_rr : data.msg[2],
		distance_rcl : data.msg[3],
                distance_rcr : data.msg[4],
                distance_fl : data.msg[5],
                distance_fr : data.msg[6],
                distance_fcl : data.msg[7],
                distance_fcr : data.msg[8],
	};

	log.module('Distances: ' + parse.distance_fl + ', ' + parse.distance_fcl + ', ' + parse.distance_fcr + ', ' + parse.distance_fr + '\n' + parse.distance_rl + ', ' + parse.distance_rcl + ', ' + parse.distance_rcr + ', ' + parse.distance_rr);

	return data;
}


// Parse data sent from module
function parse_out(data) {
	switch (data.msg[0]) {
		case 0xA0 : return decode_pdc_status(data);
	}

	return data;
}

function request_pdc_status() {
        log.module('Requesting PDC status');

        bus.data.send({
		src: 'DIA',
		msg : [0x1B],
	});
}

function init_listeners() {
        update.on('status.vehicle.reverse', request_pdc_status);
        log.module('Initialized listeners');
}

module.exports = {
	parse_out,
	init_listeners,
};
